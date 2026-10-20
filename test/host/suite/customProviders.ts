import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { CUSTOM_PROVIDER_COMMANDS } from '../../../src/providers/customProviderCommands';

type Shown = { providers: string[]; rejected: Array<{ index: number; code: string }>; code: string | null; ignoredScopes: string[] };

/**
 * Custom provider settings are read from the user's own settings only. The test profile of the Extension Host is
 * isolated, so the user-level value can be written and removed here without touching anyone's real settings.
 */
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
  } finally {
    await section.update('providers.custom', original, vscode.ConfigurationTarget.Global);
  }
  assert.deepEqual((await show()).providers, [], 'the profile is back to how it was');
  return 'host smoke: custom providers are read from user settings only (workspace values never become providers); built-in ids are reserved; nothing is started from them';
}
