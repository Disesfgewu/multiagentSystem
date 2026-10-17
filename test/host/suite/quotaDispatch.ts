import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ACCOUNT_COMMANDS, accountTreeForTests } from '../../../src/accounts/accountCommands';
import { privateStorage } from '../../../src/storage/storageCommands';

type Outcome = { ok: boolean; code?: string; message?: string; session?: { id: string; state: string; terminalOpen: boolean }; sessions?: Array<{ id: string; terminalOpen: boolean }> };
const command = (id: string, input: object) => vscode.commands.executeCommand<Outcome>(id, input);
const sessions = async () => (await command('multiagentSystem.sessions.list', { interactive: false })).sessions ?? [];
async function waitUntil(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await probe()) {
    assert.ok(Date.now() < deadline, 'terminal lifecycle event did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Real registered commands and native terminals; only modal answers are synthetic. No CLI is run. */
export async function runQuotaDispatchChecks(workspace: string, accountProfileId: string): Promise<void> {
  const ids = new Set<string>();
  const originalWarning = vscode.window.showWarningMessage;
  let changeDuringConfirmation: (() => Promise<void>) | undefined;
  const ui = vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage };
  ui.showWarningMessage = (async (message: string) => {
    if (message === 'Account isolation is not verified for this CLI on this machine.') return 'Continue';
    if (message === 'Account limits ask you to confirm.') {
      await changeDuringConfirmation?.();
      return 'Start Anyway';
    }
    if (message === 'Account limits are holding back new agents.') return 'Override and Start';
    throw new Error(`Unexpected quota test dialog: ${message}`);
  }) as typeof vscode.window.showWarningMessage;
  const policy = async (clear = false, unknownQuota = 'require-confirmation') => {
    const result = await command(ACCOUNT_COMMANDS.limits, { id: accountProfileId, interactive: false, clear, max: '1', unknownQuota });
    assert.ok(result.ok);
  };
  const start = async (name: string, interactive = false) => {
    const result = await command('multiagentSystem.sessions.start', { provider: 'claude', name, cwd: workspace, accountProfileId, interactive, requestedModel: null, launch: false });
    if (result.session) ids.add(result.session.id);
    return result;
  };
  const stop = async (id: string) => { assert.ok((await command('multiagentSystem.sessions.stop', { id, interactive: false })).ok); };
  try {
    await policy(true);
    const beforeLimits = await start('Before limits');
    assert.ok(beforeLimits.ok);
    await policy();
    assert.equal((await start('Over existing limit', true)).ok, false, 'a session started with no policy still consumes the newly configured limit');
    const blocked = (await accountTreeForTests().getChildren())?.find((row) => row.id === accountProfileId);
    assert.match(String(blocked?.description), /BLOCKED NOW/);
    assert.match(String(blocked?.tooltip), /1 agent is already running/);
    await policy(true);
    await policy();
    assert.equal((await start('After resetting limits', true)).ok, false, 'clearing and setting limits does not forget the active session');
    await stop(beforeLimits.session!.id);

    const racing = await Promise.all([start('Race one', true), start('Race two', true)]);
    assert.equal(racing.filter((result) => result.ok).length, 1, 'only one registered command reserves the final slot');
    const winner = racing.find((result) => result.ok)!;
    const reopening = await command('multiagentSystem.sessions.reopen', { id: beforeLimits.session!.id, interactive: false, launch: false });
    assert.deepEqual([reopening.ok, reopening.code], [false, 'quota-gate'], 'reopen uses the same occupied slot limit');
    await stop(winner.session!.id);

    changeDuringConfirmation = async () => { await policy(false, 'block'); };
    const changed = await start('Changed policy', true);
    assert.deepEqual([changed.ok, changed.code], [false, 'quota-gate']);
    assert.match(changed.message ?? '', /limits changed/i, 'approval for an older policy cannot authorize a changed one');
    changeDuringConfirmation = undefined;

    // Hold the actual snapshot save after native terminal creation, then close the terminal before
    // the launch command receives its session. The reservation must not be orphaned at handoff.
    await policy(true);
    const handle = privateStorage()!;
    const originalUse = handle.use;
    let resume!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const waiting = new Promise<void>((resolve) => { began = resolve; });
    let intercepted = false;
    handle.use = async () => {
      if (!intercepted && vscode.window.terminals.some((terminal) => terminal.name === 'Multiagent: Closed while saving')) {
        intercepted = true;
        began();
        await gate;
      }
      return originalUse.call(handle);
    };
    let pending: Promise<Outcome> | undefined;
    try {
      pending = start('Closed while saving');
      await Promise.race([waiting, pending.then(() => { throw new Error('the snapshot save was not intercepted'); })]);
      vscode.window.terminals.find((terminal) => terminal.name === 'Multiagent: Closed while saving')!.dispose();
      await waitUntil(async () => (await sessions()).filter((entry) => entry.terminalOpen).length === 0);
      resume();
      const earlyClose = await pending;
      assert.ok(earlyClose.ok);
      assert.deepEqual([earlyClose.session?.state, earlyClose.session?.terminalOpen], ['terminal-closed', false]);
    } finally {
      resume();
      handle.use = originalUse;
      await pending;
    }
    await policy();
    const afterClose = await start('After early close', true);
    assert.ok(afterClose.ok, 'the early-close reservation was freed, so the next launch can take the slot');
    await stop(afterClose.session!.id);
  } finally {
    ui.showWarningMessage = originalWarning;
    for (const entry of await sessions()) if (ids.has(entry.id) && entry.terminalOpen) await stop(entry.id);
    await policy(true);
  }
  console.log('host smoke: account limits count earlier sessions, serialize racing starts/reopen, reject changed-policy approval and free reservations when a terminal closes during snapshot save');
}
