import { Handoff } from './types';

/** One line in the shared CSV. */
export interface Row {
  developer: string;
  date: string;
  context: string;
}

export const HEADER = ['Developer Name', 'Date', 'Context'];

/** Identity of a row; makes re-appending after a rejected push idempotent. */
export const rowKey = (r: Row) => `${r.developer}\u0000${r.date}\u0000${r.context}`;

/** Flatten a structured handoff into the single markdown Context cell. */
export function handoffToRow(h: Handoff): Row {
  const parts = [`**${h.title.trim()}**`, '', h.summary.trim()];
  if (h.decisions.trim()) parts.push('', '**Decisions**', h.decisions.trim());
  if (h.open_issues.trim()) parts.push('', '**Open issues**', h.open_issues.trim());
  if (h.files_touched.trim()) parts.push('', `**Touched:** ${h.files_touched.trim()}`);
  if (h.branch) parts.push('', `**Branch:** \`${h.branch}\``);
  return { developer: h.author, date: h.created_at, context: parts.join('\n') };
}

const CONFLICT_START = /^<<<<<<< .*$/m;
const CONFLICT_END = /^>>>>>>> .*$/m;

/**
 * Parse the shared CSV. If someone committed git conflict markers by hand, both sides are kept:
 * the file is append-only, so the union of the two sides is the correct resolution.
 */
export function parseRows(text: string): Row[] {
  text = text.replace(/^﻿/, '');
  if (CONFLICT_START.test(text) && CONFLICT_END.test(text)) {
    text = text.replace(/^(<<<<<<< |=======$|>>>>>>> ).*\r?\n?/gm, '');
  }
  const records = parseCsv(text);
  if (records.length && records[0][0]?.trim() === HEADER[0]) records.shift();
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const rec of records) {
    const row: Row = {
      developer: rec[0] ?? '',
      date: rec[1] ?? '',
      context: (rec[2] ?? '').replace(/\r\n/g, '\n'),
    };
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

export function stringifyRows(rows: Row[]): string {
  const lines = [HEADER, ...rows.map(r => [r.developer, r.date, r.context.replace(/\r\n/g, '\n')])];
  return lines.map(rec => rec.map(quote).join(',')).join('\n') + '\n';
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Minimal RFC 4180 parser: quoted fields may contain commas, quotes and newlines. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records.filter(r => !(r.length === 1 && r[0] === ''));
}
