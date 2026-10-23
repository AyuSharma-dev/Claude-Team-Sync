/** One line in .claude/team-sync/pending.jsonl, written by the SessionEnd hook. */
export interface PendingSession {
  session_id: string;
  cwd: string;
  branch: string;
  ts: string;
  reason?: string;
}

/** A generated handoff before it is flattened into a CSV row. All fields are plain strings. */
export interface Handoff {
  id: string;
  created_at: string;
  author: string;
  branch: string;
  title: string;
  summary: string;
  decisions: string;
  files_touched: string;
  open_issues: string;
  session_id: string;
}

/** Fields Claude fills in when summarizing a session. */
export type HandoffContent = Pick<Handoff, 'title' | 'summary' | 'decisions' | 'files_touched' | 'open_issues'>;
