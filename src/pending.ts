import * as fs from 'fs';
import * as path from 'path';
import { PendingSession } from './types';

export function teamSyncDir(root: string): string {
  return path.join(root, '.claude', 'team-sync');
}

export function pendingFile(root: string): string {
  return path.join(teamSyncDir(root), 'pending.jsonl');
}

export function readPending(root: string): PendingSession[] {
  const file = pendingFile(root);
  if (!fs.existsSync(file)) return [];
  const seen = new Set<string>();
  const result: PendingSession[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as PendingSession;
      // A session can end more than once (resume, then exit again); keep the latest.
      if (seen.has(entry.session_id)) {
        const idx = result.findIndex(r => r.session_id === entry.session_id);
        result[idx] = entry;
      } else {
        seen.add(entry.session_id);
        result.push(entry);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return result;
}

/** Remove processed sessions. Re-reads the file so lines appended meanwhile by the hook survive. */
export function removePending(root: string, sessionIds: Iterable<string>): void {
  const file = pendingFile(root);
  if (!fs.existsSync(file)) return;
  const done = new Set(sessionIds);
  const kept = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(line => {
      if (!line.trim()) return false;
      try {
        return !done.has((JSON.parse(line) as PendingSession).session_id);
      } catch {
        return false;
      }
    });
  fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
}
