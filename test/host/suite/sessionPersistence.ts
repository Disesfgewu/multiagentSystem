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
  const fixed = ({ id, name, provider, repoId, roleGroupId, accountProfileId, worktree, requestedModel, codename }: SessionView) => ({ id, name, provider, repoId, roleGroupId, accountProfileId, worktree, requestedModel, codename });
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
  // Issue #342: the session has a codename from its role, and the agent is told it and how to sign its GitHub posts.
  const codename = startResult.session!.codename;
  assert.match(codename ?? '', /^PM-[0-9]{2,4}$/, 'a PM role group gives a PM codename');
  assert.ok(content.includes(`你的代號是 ${codename}。`) && content.includes(`第一行都必須是 \`— ${codename}\``), 'the injected instructions carry the codename and the signature line');
  // The session's gh wrapper: shims in the private folder with this codename written into them, first on the terminal's PATH.
  const shimDir = path.join(privateDir, 'gh-wrapper', sessionId);
  const shim = fs.readFileSync(path.join(shimDir, 'gh'), 'utf8');
  assert.ok(shim.includes('multiagentSystem gh wrapper') && shim.includes(`'--mas-codename' '${codename}'`), 'the gh shim carries the codename');
  assert.equal(fs.existsSync(path.join(shimDir, 'gh.cmd')), false, 'there is never a gh.cmd');
  assert.equal(fs.existsSync(path.join(shimDir, 'gh.ps1')), process.platform === 'win32', 'a PowerShell shim on Windows only');
  const sessionTerminal = vscode.window.terminals.find((terminal) => terminal.name.includes('Managed Instruction Session'));
  const terminalEnv = (sessionTerminal?.creationOptions as vscode.TerminalOptions | undefined)?.env ?? {};
  // PATH is not set in the terminal's options (it would replace the person's own terminal PATH setting): the typed launch command
  // puts the shim folder first; the unit tests check that text.
  assert.equal(Object.keys(terminalEnv).some((name) => name.toLowerCase() === 'path' && String(terminalEnv[name]).includes(shimDir)), false);
  if (process.platform === 'win32') assert.equal(terminalEnv.PSExecutionPolicyPreference, 'RemoteSigned');

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
  assert.equal(fs.existsSync(shimDir), false, 'the gh shims are removed with the session');

  // 3. Exercise the registered Codex start command. The unit synthetic terminal test separately
  // verifies that this prepared profile is launched with `-p` and the same CODEX_HOME.
  const sourceRole = store.get('roleGroups', 'host-pm');
  assert.equal(sourceRole.ok && sourceRole.found, true);
  const codexRole = structuredClone(sourceRole.value);
  codexRole.group = { ...codexRole.group, id: 'host-codex', name: 'Host Codex', provider: 'codex', version: 1 };
  assert.equal(store.put('roleGroups', 'host-codex', codexRole).ok, true);
  const codexStart = await vscode.commands.executeCommand<{ ok: boolean; session?: SessionView }>(
    'multiagentSystem.sessions.start',
    { interactive: false, provider: 'codex', roleGroupId: 'host-codex', name: 'Managed Codex Instructions', cwd: workspace, launch: false }
  );
  assert.equal(codexStart.ok, true);
  const codexSession = codexStart.session!;
  assert.equal(codexSession.instructionMethod, 'profile-developer-instructions');
  assert.match(codexSession.codename ?? '', /^PM-[0-9]{2,4}$/);
  assert.notEqual(codexSession.codename, codename, 'another session of the same role gets another number');
  assert.equal(codexSession.instructionState, 'prepared');
  const codexProfile = path.join(privateDir, 'codex-home', `mas-${codexSession.id}.config.toml`);
  assert.equal(fs.existsSync(codexProfile), true, 'registered Codex start writes its private injection profile');
  assert.match(fs.readFileSync(codexProfile, 'utf8'), /Review the latest approved head\./);
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: codexSession.id, interactive: false });
  assert.equal(fs.existsSync(codexProfile), false, 'Codex injection profile is cleaned up on stop');

  // 4. Test stale detection on reopen: simulate store mutation during interactive review dialog
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
    const afterStale = await vscode.commands.executeCommand<{ sessions: SessionView[] }>('multiagentSystem.sessions.list', { interactive: false });
    assert.equal(afterStale.sessions.find((entry) => entry.id === sessionId)?.codename, codename, 'a reopen that did not happen moves no codename');
  } finally {
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = realShowInformationMessage;
    store.put('roleGroups', 'host-pm', roleRecord);
  }

  // 5. Test clean reopen succeeding with restored role
  const cleanReopen = await vscode.commands.executeCommand<{ ok: boolean; session?: SessionView }>(
    'multiagentSystem.sessions.reopen',
    { id: sessionId, interactive: false, launch: false }
  );
  assert.equal(cleanReopen.ok, true, 'clean reopen must succeed');
  const reopenedSessionId = cleanReopen.session!.id;
  assert.equal(cleanReopen.session!.codename, codename, 'the reopened session keeps the codename');
  assert.ok(fs.readFileSync(path.join(privateDir, 'sessions', reopenedSessionId, 'claude-context.md'), 'utf8').includes(`你的代號是 ${codename}。`), 'and is told the same one');
  const relisted = await vscode.commands.executeCommand<{ sessions: SessionView[] }>('multiagentSystem.sessions.list', { interactive: false });
  assert.equal(relisted.sessions.find((entry) => entry.id === sessionId)?.codename, null, 'the old record no longer holds it');
  const reopenedFile = path.join(privateDir, 'sessions', reopenedSessionId, 'claude-context.md');
  assert.equal(fs.existsSync(reopenedFile), true, 'reopened session creates fresh private instruction file');
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: reopenedSessionId, interactive: false });
  assert.equal(fs.existsSync(reopenedFile), false, 'reopened instruction file cleaned up on stop');

  return 'host smoke: managed Claude and Codex instructions generate private files with the session codename, reject stale reopen without moving the codename, keep it on reopen, and clean up on session stop';
}
