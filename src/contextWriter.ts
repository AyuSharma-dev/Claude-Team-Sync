import * as fs from 'fs';
import * as path from 'path';
import { CONTEXT_FILE } from './setup';
import { Row } from './teamFile';

/** Render the newest handoffs into the file CLAUDE.md imports. */
export function writeContext(root: string, project: string, rows: Row[], maxEntries: number): string {
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const shown = sorted.slice(0, maxEntries);
  const omitted = sorted.length - shown.length;

  const lines: string[] = [
    `# Team context — ${project}`,
    '',
    `_Synced ${new Date().toISOString()} · ${shown.length} handoffs` +
      (omitted > 0 ? ` (${omitted} older ones kept in the team CSV)` : '') +
      '. Generated file: do not edit; changes are overwritten on sync._',
    '',
    '## Handoffs (newest first)',
    '',
  ];
  for (const r of shown) {
    lines.push(`### ${r.developer} · ${r.date.slice(0, 10)}`, '', r.context.trim(), '');
  }

  const file = path.join(root, CONTEXT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}
