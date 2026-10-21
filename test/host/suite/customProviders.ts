import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { outsideTestMode } from './nonInteractiveGate';
import { CUSTOM_PROVIDER_COMMANDS } from '../../../src/providers/customProviderCommands';

type Shown = { providers: string[]; rejected: Array<{ index: number; code: string }>; code: string | null; ignoredScopes: string[] };

/**
 * Custom provider settings are read from the user's own settings only. The test profile of the Extension Host is
 * isolated, so the user-level value can be written and removed here without touching anyone's real settings.
 */
async function waitForFile(file: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file)) { await new Promise((resolve) => setTimeout(resolve, 200)); return fs.readFileSync(file, 'utf8'); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export async function runCustomProviderChecks(): Promise<string> {
  const section = vscode.workspace.getConfiguration('multiagentSystem');
  const show = async (): Promise<Shown> => (await vscode.commands.executeCommand<Shown>(CUSTOM_PROVIDER_COMMANDS.show)) as Shown;
  const original = section.inspect('providers.custom')?.globalValue;
  try {
    assert.deepEqual(await show(), { providers: [], rejected: [], code: null, ignoredScopes: [] }, 'nothing set: no custom provider');

    await section.update('providers.custom', [{ id: 'synthetic-cli', label: 'Synthetic CLI', executable: 'synthetic-cli', args: ['--plain'] }, { id: 'claude', label: 'Pretender', executable: 'x' }], vscode.ConfigurationTarget.Global);
    const fromUser = await show();
    assert.deepEqual(fromUser.providers, ['synthetic-cli'], 'the user-level value is read');
    assert.deepEqual(fromUser.rejected, [{ index: 1, code: 'provider-id-reserved' }], 'a built-in id cannot be taken');

    // A workspace value must never be used. The setting is application-scoped, so the editor itself refuses to store
    // it in the workspace; whether it throws or is dropped, the user's value stays the only one in effect.
    try { await section.update('providers.custom', [{ id: 'from-the-repo', label: 'Repo', executable: 'evil' }], vscode.ConfigurationTarget.Workspace); } catch { /* refused by the editor */ }
    const afterWorkspace = await show();
    assert.deepEqual(afterWorkspace.providers, ['synthetic-cli'], 'a workspace value did not become a provider');
    assert.equal(afterWorkspace.providers.includes('from-the-repo'), false);

    await section.update('providers.custom', 'not a list', vscode.ConfigurationTarget.Global);
    assert.equal((await show()).code, 'custom-providers-not-a-list', 'a malformed setting is unusable as a whole, never partly used');

    // Nothing the person put in a custom provider is repeated in a diagnostic or a storage report.
    const sentinels = ['zz-host-secret-id', 'zz-host-secret-exe', '--zz-host-secret-arg'];
    await section.update('providers.custom', [{ id: sentinels[0], label: 'Zz Host', executable: sentinels[1], args: [sentinels[2]] }], vscode.ConfigurationTarget.Global);
    const diagnostic = JSON.stringify(await vscode.commands.executeCommand('multiagentSystem.setup.diagnose', { interactive: false }));
    const storage = JSON.stringify(await vscode.commands.executeCommand('multiagentSystem.storage.status', { interactive: false }));
    for (const sentinel of sentinels) {
      assert.equal(diagnostic.includes(sentinel), false, `the diagnostic report repeats ${sentinel}`);
      assert.equal(storage.includes(sentinel), false, `the storage report repeats ${sentinel}`);
    }
    assert.ok(diagnostic.length > 100, 'the diagnostic report really was produced');

    // Starting one in a native terminal.
    const start = (arg: unknown) => vscode.commands.executeCommand<{ ok: boolean; code?: string }>(CUSTOM_PROVIDER_COMMANDS.start, arg);
    const sentinel = process.env.MULTIAGENT_TEST_CUSTOM_SENTINEL as string;
    const terminalsBefore = vscode.window.terminals.length;
    await section.update('providers.custom', [{ id: 'synthetic-custom', label: 'Synthetic Custom', executable: 'synthetic-custom-cli', args: ['--plain'] }], vscode.ConfigurationTarget.Global);
    // As an installed extension an argument cannot pick or confirm: the dialogs are asked (and dismissed here), nothing starts.
    const dismissed = await outsideTestMode(() => Promise.resolve(start({ id: 'synthetic-custom', interactive: false })));
    assert.deepEqual(dismissed.result, { ok: false, code: 'cancelled' });
    assert.ok(dismissed.prompts.some((prompt) => prompt.includes('Which custom provider should start?')), dismissed.prompts.join(' | '));
    assert.equal(vscode.window.terminals.length, terminalsBefore, 'no terminal was opened');
    assert.equal(fs.existsSync(sentinel), false);
    if (process.platform === 'win32') {
      // Only the .cmd script exists on the test PATH: it is refused, not started through a command interpreter.
      assert.deepEqual(await start({ id: 'synthetic-custom', interactive: false }), { ok: false, code: 'script-not-supported' });
    } else {
      assert.deepEqual(await start({ id: 'synthetic-custom', interactive: false }), { ok: true });
      assert.ok(vscode.window.terminals.some((terminal) => terminal.name === 'Custom: Synthetic Custom'), 'a native terminal for the provider was opened');
      assert.equal((await waitForFile(sentinel))?.trim(), '--plain', 'the program ran with exactly the listed arguments');
      for (const terminal of vscode.window.terminals.filter((candidate) => candidate.name === 'Custom: Synthetic Custom')) terminal.dispose();
    }
    // A program that exists only inside the workspace is not used, even when its folder is first on PATH.
    const workspace = process.env.MULTIAGENT_TEST_WORKSPACE as string;
    const shadow = path.join(workspace, 'shadow-bin');
    fs.mkdirSync(shadow, { recursive: true });
    const planted = path.join(shadow, process.platform === 'win32' ? 'only-in-workspace.exe' : 'only-in-workspace');
    fs.writeFileSync(planted, process.platform === 'win32' ? 'MZ' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${shadow}${path.delimiter}${originalPath ?? ''}`;
      await section.update('providers.custom', [{ id: 'shadowed', label: 'Shadowed', executable: 'only-in-workspace' }], vscode.ConfigurationTarget.Global);
      assert.deepEqual(await start({ id: 'shadowed', interactive: false }), { ok: false, code: 'executable-only-in-workspace' });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(shadow, { recursive: true, force: true });
    }
    assert.equal(vscode.window.terminals.some((terminal) => terminal.name === 'Custom: Shadowed'), false);
  } finally {
    await section.update('providers.custom', original, vscode.ConfigurationTarget.Global);
  }
  assert.deepEqual((await show()).providers, [], 'the profile is back to how it was');
  return 'host smoke: custom providers are read from user settings only (workspace values never become providers); built-in ids are reserved; a listed program starts in a native terminal only after the person picks and confirms it, never from a workspace folder, and on Windows never as a script';
}
