import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accountService } from '../../../src/accounts/accountRuntime';
import { managedWorktreeRoot } from '../../../src/projects/worktreeController';
import { privateStorage } from '../../../src/storage/storageCommands';
import { removeTemp } from './tempCleanup';

type Listed = { sessions: Array<{ id: string; trustLabel?: string }> };

/**
 * #362 in a real Extension Host: an agent started in one of this project's managed worktrees gets the worktree's trust written into
 * its account's own settings first (Claude Code's .claude.json, Codex's config.toml), keeping what else the file holds, so the CLI
 * does not stop to ask; with the setting "ask" and no one to ask, or "off", nothing is written and the card says the CLI asks once;
 * a folder outside the managed worktree folder is never written.
 */
export async function runFolderTrustChecks(workspace: string): Promise<void> {
  const settings = () => vscode.workspace.getConfiguration('multiagentSystem');
  const setTrust = (value: string | undefined) => settings().update('agents.preTrustManagedWorktrees', value, vscode.ConfigurationTarget.Global);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-trust-')));
  const accountDir = path.join(root, 'claude account');
  fs.mkdirSync(accountDir);
  const claudeJson = path.join(accountDir, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 4, projects: { '/elsewhere': { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const account = accounts.service.create({ provider: 'claude', label: 'Folder Trust Account', configDir: accountDir });
  assert.ok(account.ok, JSON.stringify(account));
  if (!account.ok) return;
  const target = path.join(managedWorktreeRoot(workspace), 'host-trust-362');
  const created = await vscode.commands.executeCommand<{ ok: boolean; message?: string }>('multiagentSystem.worktrees.create', { interactive: false, branch: 'feature/host-trust-362', target });
  assert.equal(created?.ok, true, created?.message);
  const worktree = fs.realpathSync.native(target);
  const started: string[] = [];
  const start = async (options: object) => {
    const result = await vscode.commands.executeCommand<{ ok: boolean; message?: string; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, ...options });
    assert.equal(result?.ok, true, JSON.stringify(result));
    started.push(result!.session!.id);
    return result!.session!.id;
  };
  const label = async (id: string) => (await vscode.commands.executeCommand<Listed>('multiagentSystem.sessions.list', { interactive: false })).sessions.find((entry) => entry.id === id)?.trustLabel;
  const trusted = () => JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects?.[worktree]?.hasTrustDialogAccepted === true;
  try {
    // "ask" with no one to ask: nothing is written, and the card says the CLI asks once and why.
    await setTrust(undefined);
    const asked = await start({ provider: 'claude', name: 'Trust Ask', cwd: worktree, accountProfileId: account.profile.id });
    assert.equal(trusted(), false);
    assert.equal(await label(asked), "Folder trust: not pre-written, so Claude Code asks once (you have not allowed pre-trusting this project's worktrees yet)");
    await setTrust('off');
    const off = await start({ provider: 'claude', name: 'Trust Off', cwd: worktree, accountProfileId: account.profile.id });
    assert.equal(trusted(), false);
    assert.match(await label(off) ?? '', /asks once \(pre-trusting worktrees is off in your settings/);

    // "on": the trust is written before the agent starts, and everything else in the file stays.
    await setTrust('on');
    const on = await start({ provider: 'claude', name: 'Trust On', cwd: worktree, accountProfileId: account.profile.id });
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    assert.equal(after.projects[worktree].hasTrustDialogAccepted, true);
    assert.equal(after.numStartups, 4);
    assert.equal(after.projects['/elsewhere'].hasTrustDialogAccepted, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(claudeJson).mode & 0o777, 0o600);
    assert.equal(await label(on), 'Folder trust: Claude Code will not ask to trust this worktree (trust written to the account settings)');

    // The window's own folder is not a managed worktree: nothing is written and nothing is said.
    const before = fs.readFileSync(claudeJson, 'utf8');
    const own = await start({ provider: 'claude', name: 'Trust Workspace', cwd: workspace, accountProfileId: account.profile.id });
    assert.equal(fs.readFileSync(claudeJson, 'utf8'), before);
    assert.equal(await label(own), undefined);

    // Codex: the table is appended to its config.toml.
    const codex = await start({ provider: 'codex', roleGroupId: 'host-codex', name: 'Trust Codex', cwd: worktree });
    const opened = await privateStorage()?.use();
    assert.ok(opened?.ok);
    const toml = fs.readFileSync(path.join((opened.store as { dir: string }).dir, 'codex-home', 'config.toml'), 'utf8');
    assert.ok(toml.includes(`[projects.${JSON.stringify(worktree)}]\ntrust_level = "trusted"\n`), toml);
    assert.match(await label(codex) ?? '', /^Folder trust: Codex will not ask to trust this worktree/);
  } finally {
    await setTrust(undefined);
    for (const id of started) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id, interactive: false });
    await vscode.commands.executeCommand('multiagentSystem.worktrees.remove', { interactive: false, path: target, confirmed: true });
    await accounts.service.remove(account.profile.id);
    await removeTemp(root);
  }
  console.log('host smoke: an agent started in a managed worktree has its trust written into its account\'s .claude.json or config.toml first (the rest of the file kept); with "ask" unanswered or "off" nothing is written and the card says the CLI asks once; the window\'s own folder is never written');
}
