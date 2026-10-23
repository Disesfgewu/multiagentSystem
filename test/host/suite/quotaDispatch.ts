import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ACCOUNT_COMMANDS, accountTreeForTests } from '../../../src/accounts/accountCommands';
import { overviewTreeForTests } from '../../../src/overview/overviewView';
import { privateStorage } from '../../../src/storage/storageCommands';
import { recordVerifiedIdentity, setIdentityProbe } from '../../../src/accounts/quotaGateUi';

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
  // An interactive start shows the prepared instructions (the session's codename at least, issue #342) before it starts.
  const originalInformation = vscode.window.showInformationMessage;
  const info = vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage };
  info.showInformationMessage = (async (message: string, ...rest: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('Effective agent instructions prepared')) return 'Start Agent';
    return (originalInformation as any)(message, ...rest);
  }) as typeof vscode.window.showInformationMessage;
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

    // The account row expands into its limits and readings, with a link to the token usage log (issue #294).
    const accountTree = accountTreeForTests();
    const quotaRows = (await accountTree.getChildren(blocked as any)) ?? [];
    assert.ok(quotaRows.some((row) => /^Limits:/.test(String(row.label))), 'the limits the person set are listed under the account');
    assert.ok(quotaRows.some((row) => /usage/i.test(String(row.label))), 'a reading, or the reason there is none, is listed');
    const logRow = quotaRows.find((row) => row.label === 'Token usage log')!;
    assert.ok(logRow, 'a link to the usage log is listed');
    await vscode.commands.executeCommand(logRow.command!.command, ...(logRow.command!.arguments ?? []));
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'multiagent-usage-log');
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Do not publish this document/);
    // Other checks of this suite feed synthetic readings through the real status-line path, so the log may hold entries; it holds only what a source reported, each with its source, or says nothing was recorded.
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /No usage has been recorded yet|· (?:actual|ESTIMATE|actual \+ estimate) · source [a-z0-9.-]+\n/, `the log shows reported readings with their source, or says none were recorded: ${JSON.stringify((vscode.window.activeTextEditor?.document.getText() ?? '').slice(0, 700))}`);

    const overviewRows = (await overviewTreeForTests().getChildren()) ?? [];
    const overviewBlocked = overviewRows.find((row) => (row as any).id === accountProfileId);
    assert.ok(overviewBlocked, 'the blocked account appears in the Overview');
    assert.match(String(overviewBlocked?.description), /BLOCKED NOW: 1 agent is already running on this account, and the limit is 1\./);
    assert.match(String(overviewBlocked?.tooltip), /Status: BLOCKED NOW \(1 agent is already running on this account, and the limit is 1\.\)/);
    assert.match(String(overviewBlocked?.tooltip), /Action: Click Set Account Limits to change limits, or close active sessions\./);
    assert.equal(overviewBlocked?.contextValue, 'multiagentOverviewAccountBlocked');
    assert.equal((overviewBlocked?.iconPath as vscode.ThemeIcon)?.id, 'circle-slash');

    // Test direct operation: details command accepts tree item reference directly
    await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, overviewBlocked);
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'multiagent-account');
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Account profile:/);

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

    // check -> switch -> launch: the profile was verified as one account; by the time a launch is asked for,
    // the CLI reports another one. The real start command must refuse, and an answer that cannot tell must not.
    await policy(true);
    const opened = await privateStorage()!.use();
    assert.ok(opened.ok, 'storage is available');
    const subject = (letter: string) => letter.repeat(32);
    const identity = (letter: string, loggedIn = true) => ({ provider: 'claude', loggedIn, subject: { field: 'subject', value: loggedIn ? subject(letter) : null, confidence: loggedIn ? 'actual' : 'unknown' } });
    assert.ok((recordVerifiedIdentity((opened as any).store, accountProfileId, identity('a'), new Date()) as { ok: boolean }).ok);
    try {
      setIdentityProbe(async () => ({ ok: true, identity: identity('b') }));
      const switched = await start('After switching account', true);
      assert.deepEqual([switched.ok, switched.code], [false, 'identity-changed'], 'a launch after the account changed is refused');
      assert.equal((await sessions()).filter((entry) => ids.has(entry.id) && entry.terminalOpen).length, 0, 'no terminal was opened');
      setIdentityProbe(async () => ({ ok: true, identity: identity('b', false) }));
      assert.equal((await start('After signing out', true)).code, 'identity-changed', 'signed out is refused as well');
      setIdentityProbe(async () => null);
      const unknown = await start('Could not tell', true);
      assert.ok(unknown.ok, 'an answer that cannot tell does not block the launch');
      await stop(unknown.session!.id);
      setIdentityProbe(async () => ({ ok: true, identity: identity('b') }));
      const settled = await start('Same account again', true);
      assert.ok(settled.ok, 'the change was recorded once, so the next check starts from the new state');
      await stop(settled.session!.id);
    } finally {
      setIdentityProbe(undefined);
    }
  } finally {
    ui.showWarningMessage = originalWarning;
    info.showInformationMessage = originalInformation;
    for (const entry of await sessions()) if (ids.has(entry.id) && entry.terminalOpen) await stop(entry.id);
    await policy(true);
  }
  console.log('host smoke: account limits count earlier sessions, serialize racing starts/reopen, reject changed-policy approval and free reservations when a terminal closes during snapshot save');
}
