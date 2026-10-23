import * as vscode from 'vscode';
import { Handoff } from './types';

export type ReviewDecision =
  | { action: 'push'; rows: Handoff[] }
  | { action: 'discard' }
  | { action: 'later' };

const EDITABLE: (keyof Handoff)[] = ['title', 'summary', 'decisions', 'files_touched', 'open_issues'];

/**
 * Show generated handoffs in an editable JSON tab and wait for Push / Discard / Later.
 * The notification is non-modal so the user can edit the document before choosing.
 */
export async function reviewHandoffs(rows: Handoff[]): Promise<ReviewDecision> {
  // Show only editable fields plus the id used to map edits back.
  const view = rows.map(r => ({ id: r.id, ...Object.fromEntries(EDITABLE.map(k => [k, r[k]])) }));
  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(view, null, 2),
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      `Review ${rows.length} handoff(s) in the editor tab, then push to the team repo.`,
      'Push',
      'Discard',
      'Later'
    );
    if (choice === 'Discard') {
      await closeDoc(doc);
      return { action: 'discard' };
    }
    if (choice !== 'Push') {
      // "Later" or notification dismissed: keep sessions pending for the next sync.
      await closeDoc(doc);
      return { action: 'later' };
    }

    let edited: Array<Partial<Handoff>>;
    try {
      edited = JSON.parse(doc.getText());
      if (!Array.isArray(edited)) throw new Error('top level must be an array');
    } catch (err) {
      vscode.window.showErrorMessage(`Handoff JSON is invalid (${(err as Error).message}). Fix it and choose Push again.`);
      continue;
    }

    const byId = new Map(rows.map(r => [r.id, r]));
    const result: Handoff[] = [];
    for (const e of edited) {
      const original = e.id ? byId.get(e.id) : undefined;
      if (!original) continue; // entries the user deleted from the array are simply not pushed
      const merged = { ...original };
      for (const k of EDITABLE) if (e[k] != null) merged[k] = String(e[k]);
      result.push(merged);
    }
    await closeDoc(doc);
    return { action: 'push', rows: result };
  }
}

async function closeDoc(doc: vscode.TextDocument) {
  for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === doc.uri.toString()) {
      // Untitled docs prompt to save on close; revert first so the tab closes silently.
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      return;
    }
  }
}
