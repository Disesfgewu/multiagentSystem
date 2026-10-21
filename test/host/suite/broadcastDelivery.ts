import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { privateStorage } from '../../../src/storage/storageCommands';
import { BroadcastStore } from '../../../src/broadcast/store';
import { deliverBroadcastForTests } from '../../../src/broadcast/commands';
import { SessionManager } from '../../../src/sessions/manager';

type DeliveryState = { state: 'waiting' | 'working' | 'ended' | 'unknown'; reason: string; since: string | null };

/**
 * Delivery of a broadcast into a real VS Code terminal whose "CLI" is a synthetic program: a shell loop that appends every line
 * it receives on standard input to a file. The file is the proof that the prompt reached the terminal's input; nothing here says
 * a real Claude Code or Codex would act on it. The synthetic evidence ("waiting" and so on) comes from the test, as no real hook
 * bridge runs here. POSIX only: the synthetic program is a /bin/sh loop.
 */
export async function runBroadcastDeliveryChecks(workspace: string): Promise<void> {
  if (process.platform === 'win32') { console.log('host smoke: broadcast delivery into a synthetic CLI is POSIX-only and was not run here'); return; }
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const records = new BroadcastStore(opened.store);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-delivery-')));
  const log = path.join(root, 'received.txt');
  fs.writeFileSync(log, '');
  const manager = new SessionManager<vscode.Terminal>({
    terminals: {
      create: ({ name, cwd }) => vscode.window.createTerminal({ name, cwd, shellPath: '/bin/sh', shellArgs: ['-c', `while IFS= read -r line; do printf '%s\\n' "$line" >> '${log}'; done`] })
    },
    providers: { claude: 'claude' },
    resolveProject: async () => ({ repoId: 'repo-delivery' }),
    directoryExists: (target) => fs.existsSync(target),
    detectShellType: () => 'posix'
  });
  let state: DeliveryState = { state: 'waiting', reason: 'last-hook-event', since: new Date().toISOString() };
  const sessions: any = {
    list: () => manager.list().map((entry) => ({ ...entry, deliveryState: state })),
    sendPrompt: (id: string, prompt: string) => manager.sendPrompt(id, prompt)
  };
  const started = await manager.start({ provider: 'claude', name: 'Synthetic CLI', cwd: workspace, attributionFile: path.join(root, 'attribution.json') });
  const lines = async (atLeast: number): Promise<string[]> => {
    const deadline = Date.now() + 15000;
    let got: string[] = [];
    while (Date.now() < deadline) {
      got = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      if (got.length >= atLeast) return got;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return got;
  };
  // The first line the synthetic program receives is the launch command the extension typed.
  const first = await lines(1);
  assert.match(first[0] ?? '', /^claude --settings /, 'the extension typed its launch command into the terminal');

  const text = 'Pause the current task and report where you are.';
  const create = () => {
    const made = records.create({ id: randomUUID(), version: 1, target: { scope: 'agent', agentId: started.id }, text, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), revokedAt: null });
    assert.ok(made.ok);
    return (made as { broadcast: { id: string } }).broadcast.id;
  };
  let pickId = '';
  let answer: ((buttons: string[], detail: string) => string | undefined) = () => undefined;
  const seen: Array<{ message: string; buttons: string[]; detail: string }> = [];
  const errors: string[] = [];
  const original = { pick: vscode.window.showQuickPick, warning: vscode.window.showWarningMessage, info: vscode.window.showInformationMessage, error: vscode.window.showErrorMessage };
  const ui = vscode.window as any;
  ui.showQuickPick = async (items: any[], options: vscode.QuickPickOptions) => {
    assert.equal(options.placeHolder, 'Which broadcast should be typed into the running agents?');
    return items.find((item) => item.id === pickId);
  };
  ui.showWarningMessage = async (message: string, options: { detail?: string }, ...buttons: string[]) => {
    seen.push({ message, buttons, detail: String(options?.detail ?? '') });
    return answer(buttons, String(options?.detail ?? ''));
  };
  ui.showInformationMessage = async (message: string, options?: { detail?: string }) => { seen.push({ message, buttons: [], detail: String(options?.detail ?? '') }); return undefined; };
  ui.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
  const deliveryCount = () => (records.listDeliveries() as { items: unknown[] }).items.length;
  const prompt = (id: string) => `[Administrator broadcast, created ${(records.get(id) as { broadcast: { createdAt: string } }).broadcast.createdAt}] ${text}`;
  try {
    // A. Waiting: "Send Now" types the prompt into the terminal, and the delivery is recorded.
    const a = create();
    pickId = a;
    state = { state: 'waiting', reason: 'last-hook-event', since: new Date().toISOString() };
    answer = (buttons) => buttons.includes('Send Now') ? 'Send Now' : undefined;
    const before = deliveryCount();
    await deliverBroadcastForTests(sessions);
    const afterA = await lines(2);
    assert.equal(afterA[1], prompt(a), 'the prompt reached the terminal\'s input as one line');
    assert.equal(deliveryCount(), before + 1, 'the delivery was recorded');
    const recorded = (records.listDeliveries() as { items: Array<{ broadcastId: string; results: Array<{ outcome: string; reason: string }> }> }).items.find((item) => item.broadcastId === a)!;
    assert.deepEqual(recorded.results.map((result) => [result.outcome, result.reason]), [['sent', 'waiting-for-input']]);
    assert.ok(seen.some((entry) => entry.message === 'Type this broadcast into the running agents?' && entry.detail.includes(prompt(a)) && entry.buttons.join() === 'Send Now'), 'the person saw the full prompt and only the default button');

    // B. State unknown: the default button is not offered; dismissing types nothing.
    const b = create();
    pickId = b;
    state = { state: 'unknown', reason: 'no-hook-event', since: null };
    seen.length = 0;
    answer = () => undefined;
    await deliverBroadcastForTests(sessions);
    assert.deepEqual(seen.find((entry) => entry.message === 'Type this broadcast into the running agents?')?.buttons, ['Send to Unknown Anyway'], 'only the explicit button is offered');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await lines(0)).length, 2, 'nothing was typed');

    // C. State unknown and the explicit button: typed, and the record says it was a choice.
    answer = (buttons) => buttons.find((button) => button === 'Send to Unknown Anyway');
    await deliverBroadcastForTests(sessions);
    const afterC = await lines(3);
    assert.equal(afterC[2], prompt(b));
    const unknownRecord = (records.listDeliveries() as { items: Array<{ broadcastId: string; results: Array<{ outcome: string; reason: string }> }> }).items.find((item) => item.broadcastId === b)!;
    assert.deepEqual(unknownRecord.results.map((result) => [result.outcome, result.reason]), [['sent', 'sent-unknown-state']]);

    // D. Revoked while the window is open: nothing is typed.
    const d = create();
    pickId = d;
    state = { state: 'waiting', reason: 'last-hook-event', since: new Date().toISOString() };
    errors.length = 0;
    answer = (buttons) => { assert.ok(records.revoke(d, new Date().toISOString()).ok); return buttons[0]; };
    await deliverBroadcastForTests(sessions);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await lines(0)).length, 3, 'a broadcast revoked while the dialog was open is not typed');
    assert.ok(errors.some((message) => /can no longer be sent/.test(message)));

    // E. Busy or ended: nobody can receive it, nothing is asked, nothing is typed.
    const e = create();
    pickId = e;
    for (const busy of ['working', 'ended'] as const) {
      state = { state: busy, reason: 'last-hook-event', since: new Date().toISOString() };
      seen.length = 0;
      await deliverBroadcastForTests(sessions);
      assert.ok(seen.some((entry) => entry.message === 'No session can receive this broadcast now.'), busy);
      assert.equal(seen.some((entry) => entry.message === 'Type this broadcast into the running agents?'), false, 'no confirmation for something that cannot happen');
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await lines(0)).length, 3);
  } finally {
    ui.showQuickPick = original.pick;
    ui.showWarningMessage = original.warning;
    ui.showInformationMessage = original.info;
    ui.showErrorMessage = original.error;
    try { manager.stop(started.id); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('host smoke: a broadcast is typed into a real terminal\'s input (a synthetic CLI wrote it to a file) only after the confirmation, only for sessions waiting (or unknown, by the explicit button), a revoked one is not typed, and each delivery is recorded');
}
