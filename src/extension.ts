import * as vscode from 'vscode';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { CONTEXT_FILE, isSetUp, runSetup } from './setup';
import { readPending, removePending } from './pending';
import { generateHandoff } from './handoffGenerator';
import { RepoConfig, appendRows, pullRows } from './gitClient';
import { handoffToRow } from './teamFile';
import { writeContext } from './contextWriter';
import { reviewHandoffs } from './review';
import { Handoff } from './types';

let statusBar: vscode.StatusBarItem;
let syncing = false;

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'teamSync.sync';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('teamSync.setup', () => cmdSetup()),
    vscode.commands.registerCommand('teamSync.sync', () => cmdSync(context, true)),
    vscode.commands.registerCommand('teamSync.pull', () => cmdSync(context, false)),
    vscode.commands.registerCommand('teamSync.openContext', async () => {
      const root = workspaceRoot();
      if (root) await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, CONTEXT_FILE)));
    })
  );

  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '.claude/team-sync/pending.jsonl')
    );
    watcher.onDidCreate(updateStatus);
    watcher.onDidChange(updateStatus);
    watcher.onDidDelete(updateStatus);
    context.subscriptions.push(watcher);
  }
  updateStatus();

  const cfg = vscode.workspace.getConfiguration('teamSync');
  if (root && isSetUp(root) && cfg.get<boolean>('autoPullOnStartup') && cfg.get<string>('repoUrl')) {
    cmdSync(context, false, true);
  }
}

export function deactivate() {}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function updateStatus() {
  const root = workspaceRoot();
  if (!root || !isSetUp(root)) {
    statusBar.hide();
    return;
  }
  const n = readPending(root).length;
  if (syncing) {
    statusBar.text = '$(sync~spin) Team Sync: syncing…';
    statusBar.tooltip = 'Sync in progress. If a review notification is open (check the bell icon), answer it.';
    statusBar.show();
    return;
  }
  statusBar.text = n ? `$(sync) Team Sync · ${n} pending` : '$(sync) Team Sync';
  statusBar.tooltip = n ? `${n} Claude session(s) waiting to be shared. Click to sync.` : 'Pull latest team context';
  statusBar.show();
}

async function cmdSetup() {
  const root = workspaceRoot();
  if (!root) return vscode.window.showErrorMessage('Open a project folder first.');
  try {
    const { changed } = runSetup(root);
    updateStatus();
    vscode.window.showInformationMessage(
      changed.length
        ? `Team Sync set up. Updated: ${changed.join(', ')}. Commit .claude/settings.json, .claude/hooks/ and CLAUDE.md so the whole team gets the hook.`
        : 'Team Sync is already set up for this project.'
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Team Sync setup failed: ${(err as Error).message}`);
  }
}

/** The team repo for this project. The URL is saved to workspace settings so it can be committed and shared. */
async function getRepo(context: vscode.ExtensionContext, interactive: boolean): Promise<RepoConfig | undefined> {
  const cfg = vscode.workspace.getConfiguration('teamSync');
  let repoUrl = cfg.get<string>('repoUrl')?.trim() ?? '';
  if (!repoUrl && interactive) {
    repoUrl =
      (await vscode.window.showInputBox({
        prompt: 'Git URL of this project\'s team-sync repo (needs push access)',
        placeHolder: 'https://github.com/your-org/project-team-sync.git',
        ignoreFocusOut: true,
        validateInput: v => (v.trim() ? null : 'Enter a git URL'),
      })) ?? '';
    repoUrl = repoUrl.trim();
    if (repoUrl) await cfg.update('repoUrl', repoUrl, vscode.ConfigurationTarget.Workspace);
  }
  if (!repoUrl) return undefined;
  const id = createHash('sha1').update(repoUrl).digest('hex').slice(0, 12);
  return {
    repoUrl,
    branch: cfg.get<string>('branch') || 'main',
    file: cfg.get<string>('file') || 'team-context.csv',
    dir: path.join(context.globalStorageUri.fsPath, 'repos', id),
  };
}

function projectName(root: string): string {
  return path.basename(root);
}

function authorName(root: string): string {
  const configured = vscode.workspace.getConfiguration('teamSync').get<string>('authorName');
  if (configured) return configured;
  try {
    return execSync('git config user.name', { cwd: root }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** push=true: generate, review and push pending handoffs, then pull. push=false: pull only. */
async function cmdSync(context: vscode.ExtensionContext, push: boolean, silent = false) {
  const root = workspaceRoot();
  if (!root) return;
  if (!isSetUp(root)) {
    if (silent) return;
    const choice = await vscode.window.showWarningMessage('Team Sync is not set up for this project.', 'Set Up');
    if (choice === 'Set Up') await cmdSetup();
    return;
  }
  if (syncing) {
    if (!silent) vscode.window.showInformationMessage('Team Sync is already running.');
    return;
  }
  const repo = await getRepo(context, !silent);
  if (!repo) return;

  syncing = true;
  updateStatus();
  try {
    const project = projectName(root);
    if (push) {
      if (!silent && !readPending(root).length) {
        vscode.window.showWarningMessage(
          'No finished Claude sessions to share. A session is recorded only when it ends (exit Claude Code or run /exit), and only if "Team Sync: Set Up This Project" was run before it started.'
        );
      }
      await pushPending(root, repo);
    }

    const rows = await pullRows(repo);
    const max = vscode.workspace.getConfiguration('teamSync').get<number>('maxEntries') ?? 50;
    writeContext(root, project, rows, max);
    if (!silent) vscode.window.setStatusBarMessage(`$(check) Team context updated (${rows.length} handoffs)`, 5000);
  } catch (err) {
    if (!silent) vscode.window.showErrorMessage(`Team Sync failed: ${(err as Error).message}`);
  } finally {
    syncing = false;
    updateStatus();
  }
}

async function pushPending(root: string, repo: RepoConfig) {
  const pending = readPending(root);
  if (!pending.length) return;

  const claudePath = vscode.workspace.getConfiguration('teamSync').get<string>('claudePath') || 'claude';
  const author = authorName(root);
  const rows: Handoff[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Team Sync', cancellable: false },
    async progress => {
      for (const [i, session] of pending.entries()) {
        progress.report({ message: `Summarizing session ${i + 1}/${pending.length}…`, increment: 100 / pending.length });
        try {
          const result = await generateHandoff(claudePath, session);
          if (result.skip) {
            skipped.push(session.session_id);
            continue;
          }
          rows.push({
            id: randomUUID(),
            created_at: session.ts || new Date().toISOString(),
            author,
            branch: session.branch,
            session_id: session.session_id,
            ...result.content,
          });
        } catch (err) {
          failed.push(session.session_id);
          console.error(`[teamSync] ${session.session_id}:`, err);
          vscode.window.showWarningMessage(
            `Could not summarize session ${session.session_id.slice(0, 8)}: ${(err as Error).message}. It stays pending.`
          );
        }
      }
    }
  );

  // Trivial sessions never need review; clear them right away.
  removePending(root, skipped);
  if (!rows.length) return;

  const decision = await reviewHandoffs(rows);
  if (decision.action === 'later') return;
  if (decision.action === 'push' && decision.rows.length) {
    const { appended } = await appendRows(repo, decision.rows.map(handoffToRow), author);
    vscode.window.showInformationMessage(`Shared ${appended} handoff(s) with the team.`);
  }
  removePending(root, rows.map(r => r.session_id));
}
