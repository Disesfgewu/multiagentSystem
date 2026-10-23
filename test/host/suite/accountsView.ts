import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ACCOUNT_COMMANDS, accountTreeForTests, setIdentityRunnerForTests } from '../../../src/accounts/accountCommands';
import { accountService } from '../../../src/accounts/accountRuntime';
import { privateStorage } from '../../../src/storage/storageCommands';
import { removeTemp } from './tempCleanup';
const { AccountCheckStore } = require('../../../src/accounts/account-checks') as { AccountCheckStore: new (store: unknown) => { load(ids: string[]): Map<string, any> } };

const EMAIL = 'synthetic.person@example.test';

/**
 * #352 in a real Extension Host: after a sign-in check (a synthetic `claude auth status`) and a synthetic status line reading, the
 * account row says which account it is (e-mail, organization), its plan, that it is signed in, and its usage; the e-mail address is
 * nowhere in the private store; a second folder signed in to the same account is shown as a duplicate.
 */
export async function runAccountsViewChecks(): Promise<void> {
  if (process.platform === 'win32') { console.log('host smoke: the account identity check is not run on Windows (it is not supported there), so this check was skipped'); return; }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-accounts-view-')));
  const dirs = { one: path.join(root, 'account one'), two: path.join(root, 'account two') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const one = accounts.service.create({ provider: 'claude', label: 'Identity Account One', configDir: dirs.one });
  const two = accounts.service.create({ provider: 'claude', label: 'Identity Account Two', configDir: dirs.two });
  assert.ok(one.ok && two.ok, JSON.stringify([one, two]));
  if (!one.ok || !two.ok) return;
  // The synthetic CLI answers for the folder it was started for; both folders are signed in to the same real account.
  setIdentityRunnerForTests(async (_file, _args, options) => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: EMAIL, orgId: 'org-synthetic', orgName: 'Synthetic Org', subscriptionType: 'max', configDirectory: options.env.CLAUDE_CONFIG_DIR }) }));
  const row = async (label: string) => ((await accountTreeForTests().getChildren()) ?? []).find((entry) => entry.label === label);
  try {
    const checked = await vscode.commands.executeCommand<unknown>(ACCOUNT_COMMANDS.check, { id: one.profile.id, interactive: false });
    assert.equal(JSON.stringify(checked).includes(EMAIL), false, 'the command\'s result has no e-mail address');
    const enabled = await vscode.commands.executeCommand<{ ok: boolean }>(ACCOUNT_COMMANDS.configureStatusLine, { id: one.profile.id, interactive: false, consent: true });
    assert.equal(enabled?.ok, true, `the status line was set up: ${JSON.stringify(enabled)}`);
    // What the status line bridge writes after a Claude reply in that account (after the check, so it describes this account).
    const nowSeconds = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(dirs.one, 'statusline-quota.json'), JSON.stringify({ observedAt: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: 32, resets_at: nowSeconds + 2 * 3600 + 120 }, seven_day: { used_percentage: 10, resets_at: nowSeconds + 3 * 86400 } }, model: null }));

    const first = (await accountTreeForTests().getChildren()) ?? [];
    assert.match(String(first[0]?.label ?? ''), /^\d+ accounts? · \d+ signed in · /, 'the first row is the overview line');
    const shown = await row('Identity Account One');
    const description = String(shown?.description ?? '');
    for (const part of [EMAIL, '(Synthetic Org)', 'Max plan', 'signed in', '5h 32% (resets in 2h', '7d 10%']) assert.ok(description.includes(part), `the row shows "${part}": ${description}`);
    assert.match(String(shown?.tooltip ?? ''), new RegExp(`Account: ${EMAIL.replace(/\./g, '\\.')} · Organization: Synthetic Org`));
    await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, one.profile.id);
    const details = vscode.window.activeTextEditor?.document.getText() ?? '';
    assert.match(details, /Plan: Max/);
    assert.match(details, /Usage: 5h 32%/);
    assert.match(details, /Agents using this account: none right now\./);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    // The check is saved for the next window, without the e-mail address; the private store's files hold no e-mail anywhere.
    const opened = await privateStorage()?.use();
    assert.ok(opened?.ok);
    const saved = new AccountCheckStore(opened.store).load([one.profile.id]).get(one.profile.id);
    assert.equal(saved?.identity?.plan?.value, 'max');
    assert.equal(saved?.restored, true);
    const storeDir = (opened.store as { dir: string }).dir;
    const files = (fs.readdirSync(storeDir, { recursive: true }) as string[]).map((name) => path.join(storeDir, String(name))).filter((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf8').includes(EMAIL), false, `no e-mail address in ${path.basename(file)}`);

    // The second folder is signed in to the same real account: both rows say so, with what to do.
    await vscode.commands.executeCommand(ACCOUNT_COMMANDS.check, { id: two.profile.id, interactive: false });
    const duplicate = await row('Identity Account Two');
    assert.match(String(duplicate?.description ?? ''), /DUPLICATE ACCOUNT/);
    assert.match(String(duplicate?.tooltip ?? ''), /Same account as “Identity Account One”: both folders are signed in to one real account/);
  } finally {
    setIdentityRunnerForTests(undefined);
    for (const created of [one, two]) await accounts.service.remove(created.profile.id);
    await removeTemp(root);
  }
  console.log('host smoke: an account row shows the e-mail and organization (this window only), the plan, sign-in with its check time and the usage numbers; the check is saved without the e-mail; a second folder on the same account is a duplicate');
}
