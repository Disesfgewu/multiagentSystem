import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { SessionManager, SessionView } from '../../../src/sessions/manager';
import { PrivateSessionSnapshot, sessionWorkspaceKey } from '../../../src/sessions/privateSnapshot';
import { privateStorage } from '../../../src/storage/storageCommands';
import { builtIn } from '../../../src/providers/registry';

/** Reads the real snapshot written by the registered session commands, not a seeded test record. */
export async function runSessionPersistenceChecks(): Promise<string> {
  const current = await vscode.commands.executeCommand<{ sessions: SessionView[] }>('multiagentSystem.sessions.list', { interactive: false });
  assert.ok(current?.sessions.length > 0);
  const modelSession = current.sessions.find((entry) => entry.requestedModel === 'sonnet');
  assert.ok(modelSession, 'the account-bound model selection was exercised before this check');
  const terminalCount = vscode.window.terminals.length;
  const restored = new SessionManager({
    store: new PrivateSessionSnapshot({
      workspaceKey: () => sessionWorkspaceKey((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()), vscode.workspace.workspaceFile?.toString()),
      use: async () => await privateStorage()?.use() ?? { ok: false }
    }),
    terminals: { create: () => { throw new Error('restoring must not create terminals'); } },
    providers: Object.fromEntries(builtIn.ids().map((id: string) => [id, id])),
    resolveProject: async () => { throw new Error('restoring must not resolve or launch a project'); },
    directoryExists: fs.existsSync
  });
  assert.equal((await restored.initialize()).restored, current.sessions.length, 'every real command-created session was saved');
  const fixed = ({ id, name, provider, repoId, roleGroupId, accountProfileId, worktree, requestedModel }: SessionView) => ({ id, name, provider, repoId, roleGroupId, accountProfileId, worktree, requestedModel });
  assert.deepEqual(restored.list().map(fixed), current.sessions.map(fixed));
  for (const session of restored.list()) assert.deepEqual([session.state, session.terminalOpen, session.observedAt], ['unknown', false, null]);
  await assert.rejects(restored.reopen(modelSession.id, { launch: false }), { code: 'confirm-unknown-reopen' });
  assert.equal(vscode.window.terminals.length, terminalCount);
  return 'host smoke: registered session commands save fixed settings privately; a fresh manager restores them as unknown, preserves model/account/role and opens no terminal';
}
