import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ACCOUNT_COMMANDS, accountTreeForTests, setAddAccountSeamsForTests, setIdentityRunnerForTests } from '../../../src/accounts/accountCommands';
import { accountService } from '../../../src/accounts/accountRuntime';
import { outsideTestMode } from './nonInteractiveGate';
import { removeTemp } from './tempCleanup';

const EMAIL = 'wizard.person@example.test';

/**
 * #352 in a real Extension Host, run as an installed extension: Add Claude Code Account asks for a name and one confirmation, makes
 * the recommended folder, sets up the status line and the hook bridge in that folder's own settings.json, opens the sign-in (here
 * replaced, so no real CLI runs) and checks it: the account row then shows the e-mail and plan. Cancelling makes nothing.
 */
export async function runAddAccountWizardChecks(): Promise<void> {
  if (process.platform === 'win32') { console.log('host smoke: the add-account wizard check is not run on Windows (the identity check is not supported there), so it was skipped'); return; }
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-wizard-home-')));
  // The seams exist for these tests only: an installed extension (not test mode) cannot replace the home folder or the sign-in.
  const refused = await outsideTestMode(async () => { try { setAddAccountSeamsForTests({ home }); return 'replaced'; } catch (error) { return String((error as Error).message); } });
  assert.equal(refused.result, 'This is only exposed in Extension Host tests.');
  let signIns = 0;
  setAddAccountSeamsForTests({ home, openSignIn: () => { signIns += 1; return { done: Promise.resolve() }; } });
  setIdentityRunnerForTests(async (_file, _args, options) => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: EMAIL, orgName: 'Wizard Org', subscriptionType: 'pro', configDirectory: options.env.CLAUDE_CONFIG_DIR }) }));
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const before = (accounts.service.list() as { profiles: Array<{ id: string }> }).profiles.length;
  try {
    // Cancelling the confirmation makes no folder and no account.
    const cancelled = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand(ACCOUNT_COMMANDS.addClaude)), (prompt) => (prompt.startsWith('showInputBox') ? 'Host Wizard' : undefined));
    assert.ok(cancelled.prompts.some((prompt) => prompt.startsWith('Add the Claude Code account “Host Wizard”?')), JSON.stringify(cancelled.prompts));
    assert.equal(fs.existsSync(path.join(home, 'multiagent-accounts')), false, 'no folder without the confirmation');
    assert.equal((accounts.service.list() as { profiles: unknown[] }).profiles.length, before);

    const run = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand<{ ok: boolean; steps: Array<{ step: string; ok: boolean }> }>(ACCOUNT_COMMANDS.addClaude)), (prompt) => {
      if (prompt.startsWith('showInputBox')) return 'Host Wizard';
      if (prompt.startsWith('Add the Claude Code account “Host Wizard”?')) return 'Add and Sign In';
      return undefined;
    });
    assert.equal(run.result?.ok, true, JSON.stringify(run));
    assert.deepEqual(run.result?.steps.map((step) => `${step.step}:${step.ok}`), ['folder:true', 'profile:true', 'status-line:true', 'hooks:true', 'sign-in:true', 'check:true']);
    assert.equal(signIns, 1, 'the sign-in was opened once');
    const dir = path.join(home, 'multiagent-accounts', 'claude-host-wizard');
    assert.equal(fs.statSync(dir).isDirectory(), true, 'the recommended folder was made');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.match(JSON.stringify(settings.statusLine ?? {}), /claudeStatusLineBridge/, 'the status line is set up');
    assert.ok(settings.hooks && Object.keys(settings.hooks).length > 0, 'the hook bridge is set up');
    const profile = (accounts.service.list() as { profiles: Array<{ id: string; label: string; configDir: string }> }).profiles.find((entry) => entry.label === 'Host Wizard');
    assert.ok(profile && fs.realpathSync.native(profile.configDir) === dir);
    const row = ((await accountTreeForTests().getChildren()) ?? []).find((entry) => entry.label === 'Host Wizard');
    for (const part of [EMAIL, 'Pro plan', 'signed in']) assert.ok(String(row?.description ?? '').includes(part), `the row shows "${part}": ${row?.description}`);
    if (profile) await accounts.service.remove(profile.id);
  } finally {
    setAddAccountSeamsForTests(undefined);
    setIdentityRunnerForTests(undefined);
    await removeTemp(home);
  }
  console.log('host smoke: Add Claude Code Account asks a name and one confirmation, makes the folder, sets up usage and agent state, signs in and checks it; the row shows the e-mail and plan; cancelling makes nothing');
}
