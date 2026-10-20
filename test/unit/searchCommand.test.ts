import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSearchCommand } from '../../src/research/searchCommand';
import { setExtensionTestMode } from '../../src/shared/testMode';

// A lifecycle with one running server whose search tool the researcher may call, and a counter for what reaches it.
function lifecycle() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    statusAll: async () => [{ serverId: 'papers', state: 'running', allowedTools: ['search_papers'] }],
    authorize: () => ({ allowed: true }),
    callTool: async (input: Record<string, unknown>) => { calls.push(input); return { ok: true, truncated: false, payload: '<untrusted-research-data>\n{}\n</untrusted-research-data>\n', source: {} }; }
  };
}
function ui(answers: { confirm?: boolean } = {}) {
  const seen = { picks: 0, prompts: 0, confirms: 0, shown: 0 };
  return {
    seen,
    pick: async (choices: Array<{ serverId: string; tool: string }>) => { seen.picks += 1; return choices[0]; },
    promptQuery: async () => { seen.prompts += 1; return 'typed by the person'; },
    confirm: async () => { seen.confirms += 1; return answers.confirm ?? true; },
    show: async () => { seen.shown += 1; }
  };
}
const given = { serverId: 'papers', tool: 'search_papers', query: 'from the caller', interactive: false };

test('as an installed extension an argument cannot answer for the person: they are asked, and declining sends nothing', async (t) => {
  setExtensionTestMode(false);
  t.after(() => setExtensionTestMode(false));
  const lc = lifecycle();
  const asked = ui({ confirm: false });
  const result = await runSearchCommand(given, lc, asked);
  assert.deepEqual([result.outcome.ok, result.outcome.code, result.interactive], [false, 'cancelled', true]);
  assert.deepEqual([asked.seen.picks, asked.seen.prompts, asked.seen.confirms], [1, 1, 1], 'the person picked, typed and was asked to confirm');
  assert.equal(lc.calls.length, 0, 'nothing was sent');

  // Confirming sends the person's own query, never the caller's.
  const lc2 = lifecycle();
  const agreed = await runSearchCommand(given, lc2, ui());
  assert.equal(agreed.outcome.ok, true);
  assert.deepEqual(lc2.calls.map((call) => (call.args as { query: string }).query), ['typed by the person']);
});

test('in the extension\'s own tests the caller may answer, and only with interactive:false', async (t) => {
  setExtensionTestMode(true);
  t.after(() => setExtensionTestMode(false));
  const lc = lifecycle();
  const silent = ui();
  const result = await runSearchCommand(given, lc, silent);
  assert.deepEqual([result.outcome.ok, result.interactive], [true, false]);
  assert.deepEqual([silent.seen.picks, silent.seen.prompts, silent.seen.confirms], [0, 0, 0]);
  assert.deepEqual(lc.calls.map((call) => (call.args as { query: string }).query), ['from the caller']);

  const lc2 = lifecycle();
  const asked = ui({ confirm: false });
  const interactiveArg = await runSearchCommand({ ...given, interactive: true }, lc2, asked);
  assert.deepEqual([interactiveArg.outcome.code, asked.seen.confirms, lc2.calls.length], ['cancelled', 1, 0], 'interactive:true still asks');
  const noArg = await runSearchCommand(undefined, lifecycle(), ui({ confirm: false }));
  assert.equal(noArg.outcome.code, 'cancelled');
});
