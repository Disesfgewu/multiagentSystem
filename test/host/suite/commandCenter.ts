import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { accountService } from '../../../src/accounts/accountRuntime';
import { pullRequestSummary, setReportDepsForTests } from '../../../src/reports/reportsView';
import { commandCenterForTests, commandCenterHtmlForTests, commandCenterOpenForTests, COMMAND_CENTER_COMMAND, COMMAND_CENTER_VIEW_TYPE } from '../../../src/commandCenter/commandCenter';

type Session = { id: string; name: string };

/**
 * The Command Center in a real editor (issue #309): the command opens one webview tab in the editor area, the page carries a
 * strict content security policy, the screen shows a card for a real session with unknown where nothing is known, the person's
 * layout is kept, and the messages a page may send are checked. The webview's own script is not run here (no browser is driven);
 * its messages go through the same handler the real page's messages do.
 */
export async function runCommandCenterChecks(workspace: string): Promise<void> {
  const started = await vscode.commands.executeCommand<{ ok: boolean; session?: Session }>('multiagentSystem.sessions.start', { provider: 'claude', name: 'Command Center Subject', cwd: workspace, interactive: false, launch: false });
  assert.ok(started.ok && started.session);
  const subject = started.session!;
  try {
    await vscode.commands.executeCommand(COMMAND_CENTER_COMMAND);
    assert.equal(commandCenterOpenForTests(), true, 'the command opened the panel');
    const mineTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(COMMAND_CENTER_VIEW_TYPE));
    const deadline = Date.now() + 10000;
    while (mineTabs().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mineTabs().length, 1, `one Command Center tab, in the editor area (tabs: ${JSON.stringify(vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => [tab.label, (tab.input as { viewType?: string } | undefined)?.viewType]))})`);
    await vscode.commands.executeCommand(COMMAND_CENTER_COMMAND);
    assert.equal(mineTabs().length, 1, 'opening it again shows the same tab');

    const html = commandCenterHtmlForTests() ?? '';
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /unsafe-inline|https?:\/\//);

    const center = commandCenterForTests();
    // The page announces itself too, which starts a refresh of its own; the newest read is the one that is kept.
    await center.refresh();
    const readyBy = Date.now() + 15000;
    while (!center.state() && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 100));
    const state = center.state() as { pm: Array<{ id: string }>; agents: Array<{ id: string; name: string; status: { state: string }; task: { text: string }; model: string; account: string }>; layout: { mode: string }; decisions: { issues: { known: boolean }; pullRequests: { known: boolean } } };
    const card = state.agents.find((entry) => entry.id === subject.id);
    assert.ok(card, 'a card for the real session');
    assert.equal(card!.name, 'Command Center Subject');
    assert.equal(card!.status.state, 'unknown', 'a terminal that exists is not "working" without hook evidence');
    assert.match(card!.task.text, /no task is known/);
    assert.equal(card!.model, 'CLI default');
    assert.match((card as any).worktree, /^(unknown|no uncommitted changes|\d+ changed)/, 'one line about the working folder is on the card');
    assert.deepEqual((card as any).report.lines, ['Latest report: none (no pull request is linked to this agent)'], 'an agent with no pull request has no report');
    assert.equal(state.layout.mode, 'grid');
    assert.equal(typeof state.decisions.issues.known, 'boolean');

    // The person's layout is kept, and only whitelisted messages for cards on screen are obeyed.
    assert.deepEqual(await center.handle({ type: 'setLayout', mode: 'list' }), { ok: true, command: 'setLayout' });
    assert.deepEqual(await center.handle({ type: 'togglePin', id: subject.id }), { ok: true, command: 'togglePin' });
    assert.deepEqual(await center.handle({ type: 'toggleCollapse', id: subject.id }), { ok: true, command: 'toggleCollapse' });
    const after = center.state() as { layout: { mode: string; pinned: string[]; collapsed: string[] }; agents: Array<{ id: string; pinned: boolean; collapsed: boolean }> };
    assert.equal(after.layout.mode, 'list');
    assert.deepEqual([after.layout.pinned, after.layout.collapsed], [[subject.id], [subject.id]]);
    assert.deepEqual(after.agents.find((entry) => entry.id === subject.id) && [after.agents.find((entry) => entry.id === subject.id)!.pinned, after.agents.find((entry) => entry.id === subject.id)!.collapsed], [true, true]);
    for (const [message, reason] of [
      [{ type: 'executeCommand', command: 'multiagentSystem.sessions.stop' }, 'unknown-command'],
      [{ type: 'stop', id: subject.id }, 'unknown-command'],
      [{ type: 'focus', id: 'not-a-card' }, 'unknown-id'],
      [{ type: 'focus', id: subject.id, command: 'multiagentSystem.sessions.stop' }, 'unexpected-field'],
      [{ type: 'setLayout', mode: 'tiles' }, 'invalid-field'],
      [{ type: 'reorder', order: [subject.id, subject.id] }, 'invalid-field'],
      [null, 'unknown-command']
    ] as Array<[unknown, string]>) assert.deepEqual(await center.handle(message), { ok: false, reason }, JSON.stringify(message));
    assert.equal((await vscode.commands.executeCommand<{ sessions?: Session[] }>('multiagentSystem.sessions.list', { interactive: false })).sessions?.some((entry) => entry.id === subject.id), true, 'a refused message stopped nothing');
    assert.deepEqual(await center.handle({ type: 'focus', id: subject.id }), { ok: true, command: 'focus' });
    // The account panel (issue #304): a real profile, its sign-in and quota as the services know them, and the account actions, which are the
    // existing account commands with their own dialogs (answered here by cancelling them).
    const accountDir = path.join(path.dirname(workspace), 'synthetic-command-center-account');
    fs.mkdirSync(accountDir, { recursive: true });
    const accounts = await accountService(() => []);
    assert.ok(accounts.ok);
    if (accounts.ok) {
      const created = accounts.service.create({ provider: 'claude', label: 'Command Center Account', configDir: accountDir });
      assert.ok(created.ok, JSON.stringify(created));
      if (created.ok) {
        const accountId = created.profile.id as string;
        const original = { pick: vscode.window.showQuickPick, input: vscode.window.showInputBox };
        const ui = vscode.window as any;
        try {
          await center.refresh();
          const waitFor = async () => { const by = Date.now() + 15000; let found: any; while (!(found = (center.state() as any)?.accounts?.find((row: { id: string }) => row.id === accountId)) && Date.now() < by) { await center.refresh(); await new Promise((resolve) => setTimeout(resolve, 100)); } return found; };
          const row = await waitFor();
          assert.ok(row, 'the account is a row on the screen');
          assert.equal(row.label, 'Command Center Account');
          assert.equal(row.provider, 'Claude Code');
          assert.equal(row.signIn, 'sign-in not checked in this window');
          assert.match(row.identity, /^identity unknown/);
          assert.equal(row.usageKnown, false, 'no reading source is enabled for this account, so nothing is shown as a number');
          assert.equal(row.reason.short, 'usage bridge not enabled');
          assert.deepEqual(row.reason.next, { action: 'configureStatusLine', label: 'Enable the Claude status line bridge' }, 'the next step is a click');
          assert.equal(row.agentCount, 0);
          assert.match(row.policy, /^Limits: none set/);

          ui.showQuickPick = async () => undefined;
          ui.showInputBox = async () => undefined;
          assert.deepEqual(await center.handle({ type: 'accountAction', action: 'details', id: accountId }), { ok: true, command: 'accountAction:details' });
          assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'multiagent-account');
          assert.deepEqual(await center.handle({ type: 'accountAction', action: 'usageLog', id: accountId }), { ok: true, command: 'accountAction:usageLog' });
          assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'multiagent-usage-log');
          assert.deepEqual(await center.handle({ type: 'accountAction', action: 'limits', id: accountId }), { ok: true, command: 'accountAction:limits' }, 'the limits dialogs are the account command\'s own, and cancelling them changes nothing');
          assert.match((await waitFor()).policy, /^Limits: none set/);
          assert.deepEqual(await center.handle({ type: 'accountAction', action: 'create' }), { ok: true, command: 'accountAction:create' });
          for (const [message, reason] of [
            [{ type: 'accountAction', action: 'remove', id: accountId }, 'invalid-field'],
            [{ type: 'accountAction', action: 'login', id: 'not-an-account' }, 'unknown-id'],
            [{ type: 'accountAction', action: 'create', id: accountId }, 'unexpected-field'],
            [{ type: 'accountAction', action: 'details', id: subject.id }, 'unknown-id']
          ] as Array<[unknown, string]>) assert.deepEqual(await center.handle(message), { ok: false, reason }, JSON.stringify(message));
          assert.ok((await accountService(() => []) as any).service.get(accountId).ok, 'a refused message removed nothing');
        } finally {
          ui.showQuickPick = original.pick;
          ui.showInputBox = original.input;
          await accounts.service.remove(accountId);
          fs.rmSync(accountDir, { recursive: true, force: true });
        }
      }
    }
    // back to the defaults for the other checks
    await center.handle({ type: 'setLayout', mode: 'grid' });
    await center.handle({ type: 'togglePin', id: subject.id });
    await center.handle({ type: 'toggleCollapse', id: subject.id });
  } finally {
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(COMMAND_CENTER_VIEW_TYPE)) await vscode.window.tabGroups.close(tab);
    await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: subject.id, interactive: false });
  }
  assert.equal(commandCenterOpenForTests(), false, 'closing the tab disposes the panel');

  // The latest report of a pull request: read the way the full report is, kept for a minute, and unknown when it cannot be read.
  const HEAD = 'a'.repeat(40);
  let reads = 0;
  let broken = false;
  const reader: any = {
    getPullRequest: async () => { reads += 1; if (broken) throw new Error('offline'); return { kind: 'ok', data: { number: 7, headSha: HEAD, title: 't', state: 'open' } }; },
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'approved', headSha: HEAD }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD, failing: [] }, unresolvedThreads: 0 }),
    getIssueComments: async () => ({ kind: 'ok', data: [] })
  };
  setReportDepsForTests({ repository: async () => 'o/r', readerFor: () => reader });
  try {
    const first = await pullRequestSummary(7);
    assert.deepEqual(first, { pm: 'missing', userCan: null, next: null, approval: 'approved', ci: 'passing', unresolved: 0 });
    await pullRequestSummary(7);
    assert.equal(reads, 1, 'the second look is answered from the minute-long keep, not read again');
    broken = true;
    setReportDepsForTests({ repository: async () => 'o/r', readerFor: () => reader });
    assert.equal(await pullRequestSummary(8), null, 'a report that cannot be read is null: the screen says unknown');
    for (const bad of [0, -1, 1.5, Number.NaN, '7' as unknown as number]) assert.equal(await pullRequestSummary(bad), null, String(bad));
  } finally { setReportDepsForTests(undefined); }
  console.log('host smoke: the Command Center opens as one editor tab with a strict content security policy, shows a card with unknown where nothing is known, keeps the layout, and refuses every message that is not on the whitelist');
}

/**
 * #368 in a real Extension Host: five agents started one after another, each start firing its own change, all have a card after
 * the refresh: requests made while a refresh runs make one more run instead of throwing the result away.
 */
export async function runCommandCenterManyAgentsChecks(workspace: string): Promise<void> {
  const ids: string[] = [];
  try {
    await vscode.commands.executeCommand(COMMAND_CENTER_COMMAND);
    const center = commandCenterForTests();
    const running: Array<Promise<void>> = [];
    for (let index = 0; index < 5; index += 1) {
      const started = await vscode.commands.executeCommand<{ ok: boolean; session?: Session }>('multiagentSystem.sessions.start', { provider: 'claude', name: `Many Agents ${index}`, cwd: workspace, interactive: false, launch: false });
      assert.ok(started.ok && started.session);
      ids.push(started.session!.id);
      // A refresh is asked for after every start, while the earlier ones may still be running.
      running.push(center.refresh());
    }
    await Promise.all(running);
    const cards = ((center.state() as { agents: Array<{ id: string }>; pm: Array<{ id: string }> }).agents ?? []).map((card) => card.id);
    for (const id of ids) assert.ok(cards.includes(id), `a card for every agent (missing ${id}; cards: ${JSON.stringify(cards)})`);
  } finally {
    for (const id of ids) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id, interactive: false });
  }
  console.log('host smoke: five agents started in a row all have a card once the refreshes asked for meanwhile have run');
}
