import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accountService } from '../../../src/accounts/accountRuntime';
import { commandCenterForTests } from '../../../src/commandCenter/commandCenter';
import { removeTemp } from './tempCleanup';

type Said = { type: string; state: string; kind?: string; to?: string; prompt?: string; reason?: string; sent?: boolean; recipients?: Array<{ label: string }> };

/**
 * #357's "say it" box (#360 guideline 3) in a real Extension Host, with a real agent on the Workbench: a line that names the agent is
 * said back as a task with the exact line; it is carried out only for the same text, through the shared typing flow (no CLI runs here,
 * so nothing is typed); a question that names it is said back as a question for it; a line that names nobody does nothing and says why.
 */
export async function runSayBoxChecks(workspace: string): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-say-')));
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  fs.mkdirSync(path.join(root, 'say-account'));
  const created = accounts.service.create({ provider: 'claude', label: 'Say Account', configDir: path.join(root, 'say-account') });
  assert.ok(created.ok, JSON.stringify(created));
  if (!created.ok) return;
  const started = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string; codename?: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Say Target', cwd: workspace, accountProfileId: created.profile.id });
  assert.equal(started?.ok, true, JSON.stringify(started));
  const id = started!.session!.id;
  const ui = vscode.window as any;
  const original = { warning: ui.showWarningMessage, info: ui.showInformationMessage };
  const asked: string[] = [];
  let late: string | undefined;
  ui.showWarningMessage = async (title: string, options: { detail?: string }) => { asked.push(`${title}\n${options?.detail ?? ''}`); return undefined; };
  ui.showInformationMessage = async (title: string, options?: { detail?: string }) => { asked.push(`${title}\n${options?.detail ?? ''}`); return undefined; };
  try {
    await vscode.commands.executeCommand('multiagentSystem.workbench.open', { tab: 'agents' });
    const center = commandCenterForTests();
    await center.refresh();
    const card = ((center.state() as { agents: Array<{ id: string; codename: string | null }> }).agents).find((entry) => entry.id === id);
    assert.ok(card?.codename, 'the agent has a codename to be named by');
    const said = (): Said => center.say() as Said;
    const line = `${card.codename} please run the tests`;

    assert.deepEqual(await center.handle({ type: 'sayPreview', text: line }), { ok: true, command: 'sayPreview' });
    assert.equal(said().state, 'preview', JSON.stringify(said()));
    assert.equal(said().kind, 'task');
    assert.match(said().prompt ?? '', new RegExp(`^\\[Task from the administrator\\] .*${card.codename} please run the tests`));
    assert.deepEqual(said().recipients?.map((entry) => entry.label), [`${card.codename} · Say Target`]);
    assert.equal(asked.length, 0, 'a preview asks and types nothing');

    // Another text than the one previewed is not carried out, and the preview is used up.
    await center.handle({ type: 'sayRun', text: `${line}!` });
    assert.match(said().reason ?? '', /text changed since the preview/);
    await center.handle({ type: 'sayRun', text: line });
    assert.match(said().reason ?? '', /Preview it first/, 'one preview, one run');

    // The previewed line goes into the shared typing flow, which shows the whole line and its recipients before anything is typed.
    // This agent was started without a CLI, so that flow says nobody can receive it now and types nothing (the e2e types for real).
    await center.handle({ type: 'sayPreview', text: line });
    await center.handle({ type: 'sayRun', text: line });
    assert.ok(asked.some((text) => /^No session can receive this task now\.[\s\S]*Say Target[\s\S]*please run the tests/.test(text)), asked.join(' | '));
    assert.deepEqual([said().state, said().sent], ['results', false]);

    await center.handle({ type: 'sayPreview', text: 'please run the tests' });
    assert.match(said().reason ?? '', /Say who should do it/);
    await center.handle({ type: 'sayPreview', text: `${card.codename}, why is CI red?` });
    assert.deepEqual([said().state, said().kind, said().to], ['preview', 'ask', `${card.codename} · Say Target`], JSON.stringify(said()));
    // The page cannot name a target or send anything else with the line.
    assert.equal((await center.handle({ type: 'sayRun', text: line, ids: [id] })).ok, false);

    // The agents on the screen changed after the preview: "everyone" is no longer who was previewed, so nothing is carried out.
    await center.handle({ type: 'sayPreview', text: 'Everyone: please commit your work' });
    assert.deepEqual([said().state, said().kind], ['preview', 'broadcast'], JSON.stringify(said()));
    const more = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Say Late', cwd: workspace, accountProfileId: created.profile.id });
    assert.equal(more?.ok, true);
    late = more!.session!.id;
    await center.refresh();
    const shown = asked.length;
    await center.handle({ type: 'sayRun', text: 'Everyone: please commit your work' });
    assert.match(said().reason ?? '', /agents on the screen changed since the preview/);
    assert.equal(asked.length, shown, 'nothing was asked or typed');
  } finally {
    ui.showWarningMessage = original.warning;
    ui.showInformationMessage = original.info;
    await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id, interactive: false });
    if (late) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: late, interactive: false });
    await removeTemp(root);
  }
  console.log('host smoke: the "say it" box says back a task for the agent it names with the exact line, carries out only that same line to the same agents through the shared typing flow, and refuses a line that names nobody');
}
