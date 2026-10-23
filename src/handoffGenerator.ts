import { spawn } from 'child_process';
import { HandoffContent, PendingSession } from './types';

const PROMPT = `You are writing a handoff note about THIS conversation for teammates on the same project, and for the author's own future reference.
Do not use any tools. Be strict about what is worth sharing. Include ONLY information that someone would need later and could not easily get from the code or git history:
- decisions made and the reasons behind them
- non-obvious findings, gotchas, constraints or root causes discovered
- work left unfinished, known risks, or things the next person must know before touching this area
Leave out: routine edits, step-by-step narration, what was merely read or browsed, debugging dead ends with no lasting lesson, and anything obvious from the diff.
If nothing in the conversation meets that bar (greetings, trivial questions, small or routine changes, exploration with no conclusions), reply with exactly: No Info
Otherwise reply with ONLY a JSON object, no prose and no code fences, with these string fields:
- "title": one line, what was worked on
- "summary": 2-5 sentences on what was done and the current state
- "decisions": bullet list ("- ...") of design/technical decisions made and why ("" if none)
- "files_touched": comma-separated files, Salesforce metadata (objects, fields, Apex classes, flows, LWCs) that matter for the above
- "open_issues": bullet list of unresolved problems, TODOs, or risks ("" if none)`;

const TIMEOUT_MS = 180_000;

export type GenerateResult = { skip: true } | { skip: false; content: HandoffContent };

/** Summarize a finished session by resuming a throwaway fork of it in headless mode. */
export function generateHandoff(claudePath: string, session: PendingSession): Promise<GenerateResult> {
  // The prompt goes over stdin: with shell:true on Windows, a multi-line argument would be mangled by cmd.exe.
  const args = [
    '-p',
    '--resume', session.session_id,
    '--fork-session',
    '--no-session-persistence',
    '--output-format', 'json',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(claudePath, args, {
      cwd: session.cwd,
      env: { ...process.env, TEAM_SYNC_INTERNAL: '1' },
      shell: process.platform === 'win32', // resolve claude.cmd on Windows
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdin.end(PROMPT);
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
        return;
      }
      try {
        resolve(parseResult(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function parseResult(stdout: string): GenerateResult {
  const envelope = JSON.parse(stdout);
  if (envelope.is_error) throw new Error(`claude returned an error: ${envelope.result}`);
  const text: string = String(envelope.result ?? '');
  if (/^\W*no info\W*$/i.test(text.trim())) return { skip: true };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`No JSON in claude reply: ${text.slice(0, 200)}`);
  const obj = JSON.parse(text.slice(start, end + 1));
  if (obj.skip) return { skip: true };
  const str = (v: unknown) => (Array.isArray(v) ? v.map(x => `- ${x}`).join('\n') : v == null ? '' : String(v));
  return {
    skip: false,
    content: {
      title: str(obj.title),
      summary: str(obj.summary),
      decisions: str(obj.decisions),
      files_touched: Array.isArray(obj.files_touched) ? obj.files_touched.join(', ') : str(obj.files_touched),
      open_issues: str(obj.open_issues),
    },
  };
}
