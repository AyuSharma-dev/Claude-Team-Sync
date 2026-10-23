import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Row, parseRows, rowKey, stringifyRows } from './teamFile';

export interface RepoConfig {
  repoUrl: string;
  branch: string;
  /** CSV path inside the repo. */
  file: string;
  /** Local clone owned by the extension. */
  dir: string;
}

const MAX_PUSH_ATTEMPTS = 5;
const GIT_TIMEOUT_MS = 120_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).toString().trim();
          reject(new Error(`git ${args[0]} failed: ${detail}`));
        } else resolve(stdout.toString());
      }
    );
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function ensureClone(cfg: RepoConfig) {
  if (fs.existsSync(path.join(cfg.dir, '.git'))) return;
  const parent = path.dirname(cfg.dir);
  fs.mkdirSync(parent, { recursive: true });
  await git(parent, ['clone', cfg.repoUrl, cfg.dir]);
}

/** Make the local clone an exact copy of the remote branch. The clone never holds work worth keeping. */
async function refresh(cfg: RepoConfig) {
  await ensureClone(cfg);
  await git(cfg.dir, ['remote', 'set-url', 'origin', cfg.repoUrl]);
  await git(cfg.dir, ['fetch', 'origin']);
  const remote = `origin/${cfg.branch}`;
  const exists = await git(cfg.dir, ['rev-parse', '--verify', '--quiet', remote]).then(() => true, () => false);
  if (exists) {
    await git(cfg.dir, ['checkout', '-f', '-B', cfg.branch, remote]);
    return;
  }
  const heads = (await git(cfg.dir, ['ls-remote', '--heads', 'origin'])).trim();
  if (heads) throw new Error(`Branch "${cfg.branch}" does not exist in ${cfg.repoUrl}. Create it or change teamSync.branch.`);
  // Brand-new empty repo: the first push creates the branch.
  await git(cfg.dir, ['symbolic-ref', 'HEAD', `refs/heads/${cfg.branch}`]);
}

function readRows(cfg: RepoConfig): Row[] {
  const file = path.join(cfg.dir, cfg.file);
  return fs.existsSync(file) ? parseRows(fs.readFileSync(file, 'utf8')) : [];
}

export async function pullRows(cfg: RepoConfig): Promise<Row[]> {
  await refresh(cfg);
  return readRows(cfg);
}

const isRace = (err: unknown) => /rejected|non-fast-forward|fetch first|cannot lock ref/i.test((err as Error).message);

/**
 * Append rows and push. Conflicts are avoided instead of merged: every attempt starts from the
 * latest remote, re-applies only our new rows, and retries if someone pushed in between.
 */
export async function appendRows(cfg: RepoConfig, newRows: Row[], author: string): Promise<{ appended: number }> {
  for (let attempt = 1; ; attempt++) {
    await refresh(cfg);
    const existing = readRows(cfg);
    const seen = new Set(existing.map(rowKey));
    const fresh = newRows.filter(r => !seen.has(rowKey(r)));
    if (!fresh.length) return { appended: 0 };

    const file = path.join(cfg.dir, cfg.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringifyRows([...existing, ...fresh]));
    await git(cfg.dir, ['add', cfg.file]);

    const identity: string[] = [];
    const name = await git(cfg.dir, ['config', 'user.name']).then(s => s.trim(), () => '');
    const email = await git(cfg.dir, ['config', 'user.email']).then(s => s.trim(), () => '');
    if (!name) identity.push('-c', `user.name=${author}`);
    if (!email) identity.push('-c', 'user.email=team-sync@users.noreply.local');
    await git(cfg.dir, [...identity, 'commit', '-m', `Team Sync: ${fresh.length} handoff(s) from ${author}`]);

    try {
      await git(cfg.dir, ['push', 'origin', `HEAD:${cfg.branch}`]);
      return { appended: fresh.length };
    } catch (err) {
      if (!isRace(err) || attempt >= MAX_PUSH_ATTEMPTS) throw err;
      await sleep(200 + Math.random() * 800);
    }
  }
}
