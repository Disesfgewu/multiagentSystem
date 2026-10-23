import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { saveRoleRecord } from '../../../src/roles/roleCommands';
import { privateStorage } from '../../../src/storage/storageCommands';
import { outsideTestMode } from './nonInteractiveGate';

type Started = { ok: boolean; code?: string; session?: { id: string } };
const ROLE = 'host-confirm-once';
const ASKED = 'Effective agent instructions prepared';
const SAME = 'Starting with the same instructions you confirmed before';

/**
 * #362 in a real Extension Host, run as an installed extension (not test mode): the person confirms an agent's instructions once;
 * another agent of the same role group with the same instructions does not ask again, only says so; when the instructions change it
 * asks again. A dismissed dialog is not remembered.
 */
export async function runConfirmOnceChecks(workspace: string): Promise<void> {
  const record = (text: string) => ({
    group: {
      id: ROLE, name: 'Host Confirm Once', role: 'worker', provider: 'claude', version: 1,
      defaultAccountProfileId: null, allowedScope: { repositories: [], paths: [] },
      toolPermissions: {}, memoryScope: { mode: 'off' },
      rules: [{ id: 'host-confirm-rule', type: 'instruction', text, version: 1 }]
    },
    layers: {}
  }) as unknown as Parameters<typeof saveRoleRecord>[0];
  assert.equal((await saveRoleRecord(record('Keep each change small.'))).ok, true);
  const started: string[] = [];
  const start = async (answer: (prompt: string) => unknown) => {
    // The account picker comes first: the CLI's default account, so nothing else is asked about the account.
    const reply = (prompt: string) => (prompt === 'showQuickPick: Choose an account for this new session' ? { label: 'Use the CLI default account', id: 'unassigned' } : answer(prompt));
    const run = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand<Started>('multiagentSystem.sessions.start', { interactive: true, provider: 'claude', roleGroupId: ROLE, name: `Confirm Once ${started.length}`, cwd: workspace, requestedModel: 'sonnet', launch: false })), reply);
    if (run.result?.ok && run.result.session) started.push(run.result.session.id);
    return run;
  };
  const agree = (prompt: string) => (prompt.startsWith(ASKED) ? 'Start Agent' : undefined);
  try {
    const dismissed = await start(() => undefined);
    assert.equal(dismissed.result?.code, 'cancelled');
    assert.ok(dismissed.prompts.some((prompt) => prompt.startsWith(ASKED)), JSON.stringify(dismissed.prompts));

    const first = await start(agree);
    assert.equal(first.result?.ok, true, JSON.stringify(first));
    assert.ok(first.prompts.some((prompt) => prompt.startsWith(ASKED)), 'a dismissed dialog was not remembered: asked again');

    const second = await start(agree);
    assert.equal(second.result?.ok, true, JSON.stringify(second));
    assert.equal(second.prompts.some((prompt) => prompt.startsWith(ASKED)), false, `the same instructions are not asked again: ${JSON.stringify(second.prompts)}`);
    assert.ok(second.prompts.some((prompt) => prompt.startsWith(SAME)), 'it says why nothing was asked');

    const opened = await privateStorage()?.use();
    assert.ok(opened?.ok);
    const current = opened.store.get('roleGroups', ROLE) as { value: Parameters<typeof saveRoleRecord>[0] & { revision: number } };
    const changed = structuredClone(current.value);
    changed.group.rules[0].text = 'Keep each change small and tested.';
    assert.equal((await saveRoleRecord(changed, current.value.revision)).ok, true);
    const third = await start(agree);
    assert.equal(third.result?.ok, true);
    assert.ok(third.prompts.some((prompt) => prompt.startsWith(ASKED)), 'changed instructions are asked again');
  } finally {
    for (const id of started) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id, interactive: false });
  }
  console.log('host smoke: confirming an agent\'s instructions once covers the next agent of the role group with the same instructions; changed instructions or a dismissed dialog are asked again');
}
