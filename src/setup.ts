import * as fs from 'fs';
import * as path from 'path';
import { teamSyncDir } from './pending';

export const CONTEXT_FILE = '.claude/team-context.md';
const HOOK_FILE = '.claude/hooks/record-session.js';
const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/record-session.js"';
const CLAUDE_MD_MARKER = '<!-- team-sync -->';

/** Runs inside Claude Code's SessionEnd hook; must stay dependency-free. */
const HOOK_SCRIPT = `#!/usr/bin/env node
// Written by the Claude Team Sync VS Code extension.
// Records finished Claude Code sessions so the extension can turn them into team handoffs.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Skip the headless sessions the extension itself runs to generate handoffs.
if (process.env.TEAM_SYNC_INTERNAL) process.exit(0);

// True if the transcript has at least one message the user actually typed.
// Slash commands like /exit and system-injected (isMeta) entries don't count.
function hasUserMessage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'user' || e.isMeta || !e.message) continue;
      const c = e.message.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(p => p && p.type === 'text').map(p => p.text).join('') : '';
      const t = text.trim();
      if (t && !t.startsWith('<command-') && !t.startsWith('<local-command-')) return true;
    } catch {}
  }
  return false;
}

let raw = '';
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    if (!input.session_id) return;
    // Empty chats have nothing to summarize and would sit in the queue forever.
    if ('transcript_path' in input && !hasUserMessage(input.transcript_path)) return;
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    let branch = '';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch {}
    const dir = path.join(root, '.claude', 'team-sync');
    fs.mkdirSync(dir, { recursive: true });
    const entry = { session_id: input.session_id, cwd: input.cwd || root, branch, ts: new Date().toISOString(), reason: input.reason || '' };
    fs.appendFileSync(path.join(dir, 'pending.jsonl'), JSON.stringify(entry) + '\\n');
  } catch {
    // never block Claude Code from exiting
  }
});
`;

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_MARKER}
## Team context
Handoffs from teammates' Claude sessions, synced by the Claude Team Sync extension:
@${CONTEXT_FILE}

Before answering or proposing a solution or design, check the team context above for related prior work,
decisions and open issues. Follow existing decisions, or say explicitly why you differ.
If a handoff already answers the question or solves the same problem, reuse that answer instead of
working it out again: say which handoff it comes from (developer and date), then verify it still matches
the current code. Only investigate further where the code has changed or the handoff does not cover the question.
${CLAUDE_MD_MARKER}
`;

export interface SetupResult {
  changed: string[];
}

export function runSetup(root: string): SetupResult {
  const changed: string[] = [];

  // 1. Hook script
  const hookPath = path.join(root, HOOK_FILE);
  if (!fs.existsSync(hookPath) || fs.readFileSync(hookPath, 'utf8') !== HOOK_SCRIPT) {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, HOOK_SCRIPT);
    changed.push(HOOK_FILE);
  }

  // 2. SessionEnd hook in the shared (committed) project settings
  const settingsPath = path.join(root, '.claude', 'settings.json');
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      throw new Error('.claude/settings.json is not valid JSON; fix it and run setup again.');
    }
  }
  settings.hooks ??= {};
  settings.hooks.SessionEnd ??= [];
  const alreadyRegistered = JSON.stringify(settings.hooks.SessionEnd).includes('record-session.js');
  if (!alreadyRegistered) {
    settings.hooks.SessionEnd.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    changed.push('.claude/settings.json');
  }

  // 3. CLAUDE.md import + solutioning instruction
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8') : '';
  if (!claudeMd.includes(CLAUDE_MD_MARKER)) {
    const sep = claudeMd && !claudeMd.endsWith('\n') ? '\n\n' : claudeMd ? '\n' : '';
    fs.writeFileSync(claudeMdPath, claudeMd + sep + CLAUDE_MD_BLOCK);
    changed.push('CLAUDE.md');
  }

  // 4. Keep per-dev sync state out of git
  const gitignorePath = path.join(root, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const wanted = [CONTEXT_FILE, '.claude/team-sync/'].filter(
    line => !gitignore.split(/\r?\n/).includes(line)
  );
  if (wanted.length) {
    const sep = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, gitignore + sep + '\n# Claude Team Sync\n' + wanted.join('\n') + '\n');
    changed.push('.gitignore');
  }

  // 5. Context file must exist so the CLAUDE.md import resolves before the first pull
  fs.mkdirSync(teamSyncDir(root), { recursive: true });
  const contextPath = path.join(root, CONTEXT_FILE);
  if (!fs.existsSync(contextPath)) {
    fs.writeFileSync(contextPath, '# Team context\n\n_No handoffs synced yet._\n');
  }

  return { changed };
}

export function isSetUp(root: string): boolean {
  return fs.existsSync(path.join(root, HOOK_FILE));
}
