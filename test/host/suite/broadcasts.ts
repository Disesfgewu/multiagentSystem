import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { privateStorage } from '../../../src/storage/storageCommands';
import { BroadcastStore } from '../../../src/broadcast/store';
import { BROADCAST_COMMANDS, BROADCAST_SCHEME, broadcastTreeForTests } from '../../../src/broadcast/commands';
import { previewText } from '../../../src/roles/roleCommands';

type Notice = { id: string; target: { scope: string; agentId?: string }; text: string; expiresAt: string | null; revokedAt: string | null };

/** Registered native UI commands with synthetic dialog answers; no CLI delivery is claimed. */
export async function runBroadcastChecks(workspace: string): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const records = new BroadcastStore(opened.store);
  const list = (): Notice[] => { const result = records.list(); assert.ok(result.ok); return (result as { items: Notice[] }).items; };
  const initialIds = new Set(list().map((item) => item.id));
  const text = 'Review the outstanding MVP decisions before starting another task. '.repeat(4).trim();
  const session = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { provider: 'claude', name: 'Broadcast target', cwd: workspace, interactive: false, launch: false });
  assert.ok(session.ok);
  const original = { pick: vscode.window.showQuickPick, input: vscode.window.showInputBox, warning: vscode.window.showWarningMessage };
  let scope: 'all' | 'roleGroup' | 'provider' | 'agent' | 'cancel' = 'all';
  let revokeId: string | undefined;
  const ui = vscode.window as { showQuickPick: typeof vscode.window.showQuickPick; showInputBox: typeof vscode.window.showInputBox; showWarningMessage: typeof vscode.window.showWarningMessage };
  ui.showQuickPick = (async (items: any[], options: vscode.QuickPickOptions) => {
    switch (options.placeHolder) {
      case 'Who should receive this broadcast?': return scope === 'cancel' ? undefined : items.find((item) => item.value === scope);
      case 'Which provider?': return items.find((item) => item.id === 'codex');
      case 'Which session should this local notice target?': return items.find((item) => item.id === session.session!.id);
      case 'How long should this broadcast stay in effect?': return items.find((item) => item.hours === 1);
      case 'Which broadcast should be revoked?': return items.find((item) => item.id === revokeId);
      default: throw new Error('Unexpected broadcast choice');
    }
  }) as unknown as typeof vscode.window.showQuickPick;
  ui.showInputBox = (async (options: vscode.InputBoxOptions) => options.prompt?.startsWith('Role id') ? 'worker' : text) as typeof vscode.window.showInputBox;
  ui.showWarningMessage = (async (message: string, options: vscode.MessageOptions) => {
    if (message === 'Save this local broadcast notice?') { assert.ok(options.detail?.includes(text)); return 'Save Notice'; }
    if (message === 'Revoke this local notice?') { assert.ok(options.detail?.includes(text)); return 'Revoke'; }
    throw new Error('Unexpected broadcast confirmation');
  }) as typeof vscode.window.showWarningMessage;
  try {
    for (const target of ['all', 'roleGroup', 'provider', 'agent'] as const) {
      scope = target;
      const before = list().length;
      await vscode.commands.executeCommand(BROADCAST_COMMANDS.send);
      assert.equal(list().length, before + 1, `the ${target} UI path saved a local notice`);
    }
    const notices = list().filter((item) => !initialIds.has(item.id));
    assert.equal(notices.length, 4);
    assert.deepEqual(notices.map((item) => item.target.scope).sort(), ['agent', 'all', 'provider', 'roleGroup']);
    assert.equal(notices.find((item) => item.target.scope === 'agent')?.target.agentId, session.session!.id);
    for (const item of notices) { assert.equal(item.text, text); assert.ok(item.expiresAt); }
    scope = 'cancel';
    await vscode.commands.executeCommand(BROADCAST_COMMANDS.send, { target: { scope: 'all' }, text: 'Payload must not authorize a notice.' });
    assert.equal(list().length, initialIds.size + 4, 'a command payload cannot bypass the interactive confirmation path');

    await vscode.commands.executeCommand(BROADCAST_COMMANDS.refresh);
    const rows = (await broadcastTreeForTests().getChildren()) ?? [];
    assert.deepEqual(rows.map((row) => (row as any).broadcast?.id).filter(Boolean).sort(), list().map((item) => item.id).sort());
    const all = notices.find((item) => item.target.scope === 'all')!;
    const row = rows.find((item) => (item as any).broadcast?.id === all.id)!;
    assert.ok(String(row.label).length < text.length, 'the long notice is abbreviated in the list');
    await vscode.commands.executeCommand(row.command!.command, ...(row.command!.arguments ?? []));
    const document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.scheme, BROADCAST_SCHEME);
    const contents = document.getText();
    assert.ok(contents.includes(text), 'clicking opens the complete notice, including text after character 60');
    assert.match(contents, /Version: 1/);
    assert.match(contents, /Expires: \d{4}-/);
    assert.match(contents, /Delivery: unknown/);
    assert.match(contents, /Session launch, CLI delivery and acknowledgement are not connected/);
    assert.equal(await document.save(), false);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, 0, 0), 'must not write');
    // VS Code can permit API edits to a virtual document's in-memory buffer. This must neither
    // save the private text nor change the stored notice; refresh restores the authoritative text.
    await vscode.workspace.applyEdit(edit);
    assert.equal(await document.save(), false);
    assert.equal(list().find((item) => item.id === all.id)?.text, text);
    await vscode.commands.executeCommand(BROADCAST_COMMANDS.refresh);
    const refreshDeadline = Date.now() + 5000;
    while (!document.getText().startsWith('PRIVATE') && Date.now() < refreshDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(document.getText().startsWith('PRIVATE'), 'refresh discards buffer edits and reads the stored notice');
    const preview = await previewText('host-pm');
    assert.ok(preview.includes(`Local administrator notice ${all.id}, version 1, user layer; expires`));

    revokeId = all.id;
    await vscode.commands.executeCommand(BROADCAST_COMMANDS.revoke);
    assert.ok(list().find((item) => item.id === all.id)?.revokedAt);
    const deadline = Date.now() + 5000;
    while (!document.getText().includes('Status: revoked') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(document.getText(), /Status: revoked/, 'an already-open detail updates after revocation');
    assert.equal((await previewText('host-pm')).includes(`Local administrator notice ${all.id},`), false);
  } finally {
    ui.showQuickPick = original.pick;
    ui.showInputBox = original.input;
    ui.showWarningMessage = original.warning;
    await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: session.session?.id, interactive: false });
    for (const item of list()) if (!initialIds.has(item.id)) opened.store.delete('broadcasts', item.id);
  }
  console.log('host smoke: broadcast commands create four target scopes via confirmed dialogs, reject a cancelled payload, open full private read-only details and revoke/refresh without claiming CLI delivery');
}
