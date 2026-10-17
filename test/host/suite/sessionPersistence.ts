import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { SessionManager, SessionView } from '../../../src/sessions/manager';
import { PrivateSessionSnapshot, sessionWorkspaceKey } from '../../../src/sessions/privateSnapshot';
import { privateStorage } from '../../../src/storage/storageCommands';
import { builtIn } from '../../../src/providers/registry';

import * as path from 'node:path';

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

/** Verifies effective instructions delivery via real session commands: file creation, 0600 mode, stale detection, and cleanup on stop. */
export async function runManagedInstructionsChecks(workspace: string): Promise<string> {
  const privateHandle = await privateStorage()?.use();
  assert.equal(privateHandle?.ok, true);
  const store = privateHandle.store as any;
  const privateDir = store.dir;

  // 1. Start a session with roleGroupId: 'host-pm'
  const startResult = await vscode.commands.executeCommand<{ ok: boolean; session?: SessionView }>(
    'multiagentSystem.sessions.start',
    { interactive: false, provider: 'claude', roleGroupId: 'host-pm', name: 'Managed Instruction Session', cwd: workspace, launch: false }
  );
  assert.equal(startResult.ok, true);
  const sessionId = startResult.session!.id;

  // Verify private instruction file was generated exclusively in privateDir outside workspace
  const expectedFile = path.join(privateDir, 'sessions', sessionId, 'claude-context.md');
  assert.equal(fs.existsSync(expectedFile), true, 'instruction file exists in private directory');
  assert.equal(expectedFile.startsWith(workspace), false, 'instruction file is outside workspace');
  const stat = fs.statSync(expectedFile);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600, 'instruction file permissions are owner-only 0600');
  }
  const content = fs.readFileSync(expectedFile, 'utf8');
  assert.match(content, /Review the latest approved head\./);

  // Verify honest state in sessions.list
  const listed = await vscode.commands.executeCommand<{ sessions: SessionView[] }>('multiagentSystem.sessions.list', { interactive: false });
  const found = listed.sessions.find((s) => s.id === sessionId);
  assert.ok(found);
  assert.equal(found.instructionState, 'prepared');
  assert.match(found.instructionDigest ?? '', /^sha256:[0-9a-f]{64}$/);

  // 2. Test cleanup on stop
  const stopResult = await vscode.commands.executeCommand<{ ok: boolean }>(
    'multiagentSystem.sessions.stop',
    { id: sessionId, interactive: false }
  );
  assert.equal(stopResult.ok, true);
  assert.equal(fs.existsSync(expectedFile), false, 'instruction file must be cleaned up on session stop');

  // 3. Test stale detection on reopen: simulate store mutation during interactive review dialog
  const loadedRole = store.get('roleGroups', 'host-pm');
  const roleRecord = (loadedRole as any).value;
  const realShowInformationMessage = vscode.window.showInformationMessage;
  try {
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = (async (message: string, ...rest: unknown[]) => {
      if (typeof message === 'string' && message.includes('Reopening session with effective instructions')) {
        // Mutate store during review dialog before user confirms
        const mutatedRole = structuredClone(roleRecord);
        mutatedRole.group.version = 999;
        store.put('roleGroups', 'host-pm', mutatedRole);
        return 'Reopen Session';
      }
      return (realShowInformationMessage as any)(message, ...rest);
    }) as typeof vscode.window.showInformationMessage;

    const staleReopen = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(
      'multiagentSystem.sessions.reopen',
      { id: sessionId, interactive: true, launch: false }
    );
    assert.deepEqual([staleReopen.ok, staleReopen.code], [false, 'stale-instructions'], 'reopen must fail when instructions became stale during review');
  } finally {
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = realShowInformationMessage;
    store.put('roleGroups', 'host-pm', roleRecord);
  }

  // 4. Test clean reopen succeeding with restored role
  const cleanReopen = await vscode.commands.executeCommand<{ ok: boolean; session?: SessionView }>(
    'multiagentSystem.sessions.reopen',
    { id: sessionId, interactive: false, launch: false }
  );
  assert.equal(cleanReopen.ok, true, 'clean reopen must succeed');
  const reopenedSessionId = cleanReopen.session!.id;
  const reopenedFile = path.join(privateDir, 'sessions', reopenedSessionId, 'claude-context.md');
  assert.equal(fs.existsSync(reopenedFile), true, 'reopened session creates fresh private instruction file');
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: reopenedSessionId, interactive: false });
  assert.equal(fs.existsSync(reopenedFile), false, 'reopened instruction file cleaned up on stop');

  return 'host smoke: managed instructions generate private files (0600), reject stale reopen, and clean up on session stop';
}
