import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareIsolationForStart, EnforcedStartUi } from '../../src/isolation/enforcedStart';

function ui(answers: { confirm?: boolean } = {}) {
  const seen = { confirms: [] as string[][], progress: 0 };
  const handle: EnforcedStartUi = {
    confirm: async (lines) => { seen.confirms.push(lines); return answers.confirm ?? true; },
    progress: async (work) => { seen.progress += 1; return work(); }
  };
  return { seen, handle };
}

const okPrepared = (log: string[] = []) => async () => ({
  ok: true as const,
  wrapCommand: (executable: string, args: string[]) => ({ executable: '/usr/bin/sandbox-exec', args: ['-f', '/p', executable, ...args] }),
  env: { HTTPS_PROXY: 'http://managed:abc@127.0.0.1:1' },
  summary: ['Enforced isolation: proven.', 'Not verified (#135): the real CLI.'],
  dispose: async () => { log.push('disposed'); }
});
const base = (extra: Record<string, unknown> = {}) => ({ mode: 'enforced', allowedDomains: ['api.provider.test'], interactive: true, storageDir: '/private/store', home: '/synthetic/home', createHarness: () => ({}), ...extra });

test('without the setting, or in advisory mode, nothing is prepared and nothing is asked: the launch is unchanged', async () => {
  for (const mode of [undefined, 'advisory']) {
    const { seen, handle } = ui();
    let prepared = 0;
    const result = await prepareIsolationForStart({ ...base({ mode }), ui: handle, prepare: (async () => { prepared += 1; return okPrepared()(); }) as never } as never);
    assert.deepEqual(result, { kind: 'advisory' });
    assert.equal(prepared, 0);
    assert.equal(seen.progress, 0);
    assert.equal(seen.confirms.length, 0);
  }
});

test('a mode that is neither advisory nor enforced refuses rather than starting without the isolation the person may have meant', async () => {
  for (const mode of ['enforce', 'Enforced', '', null, true, 1]) {
    const { handle } = ui();
    const result = await prepareIsolationForStart({ ...base({ mode }), ui: handle } as never);
    assert.equal(result.kind, 'refused', String(mode));
  }
});

test('enforced mode without private storage refuses before anything is probed', async () => {
  let prepared = 0;
  const result = await prepareIsolationForStart({ ...base({ storageDir: undefined }), ui: ui().handle, prepare: (async () => { prepared += 1; return okPrepared()(); }) as never } as never);
  assert.equal(result.kind === 'refused' && result.code, 'storage-unavailable');
  assert.equal(prepared, 0);
});

test('enforced mode with sufficient evidence asks the person, saying what is not verified, then returns the wrap and environment', async () => {
  const { seen, handle } = ui();
  const result = await prepareIsolationForStart({ ...base(), ui: handle, prepare: okPrepared() as never } as never);
  assert.equal(result.kind, 'enforced');
  assert.equal(seen.confirms.length, 1);
  assert.ok(seen.confirms[0].some((line) => line.includes('#135')));
  if (result.kind === 'enforced') {
    assert.deepEqual(result.wrap('claude', ['--x']), { executable: '/usr/bin/sandbox-exec', args: ['-f', '/p', 'claude', '--x'] });
    assert.match(result.env.HTTPS_PROXY, /127\.0\.0\.1/);
  }
});

test('declining the confirmation starts nothing and removes what was prepared', async () => {
  const log: string[] = [];
  const result = await prepareIsolationForStart({ ...base(), ui: ui({ confirm: false }).handle, prepare: okPrepared(log) as never } as never);
  assert.equal(result.kind === 'refused' && result.code, 'cancelled');
  assert.deepEqual(log, ['disposed']);
});

test('insufficient evidence refuses with the reasons and never falls back to a launch without isolation', async () => {
  const prepare = async () => ({ ok: false as const, code: 'evidence-insufficient', reasons: ['direct-http:open', 'gh-cli:control-did-not-run'], notice: 'Enforced mode was requested but is not available here, so nothing was started.' });
  const { seen, handle } = ui();
  const result = await prepareIsolationForStart({ ...base(), ui: handle, prepare: prepare as never } as never);
  assert.equal(result.kind, 'refused');
  if (result.kind === 'refused') {
    assert.equal(result.code, 'evidence-insufficient');
    assert.match(result.message, /direct-http:open/);
    assert.match(result.message, /nothing was started/);
  }
  assert.equal(seen.confirms.length, 0, 'nobody is asked to confirm something that will not happen');
});

test('only a test that answers for the person skips the confirmation (the caller passes interactive: false only then)', async () => {
  const { seen, handle } = ui();
  const result = await prepareIsolationForStart({ ...base({ interactive: false }), ui: handle, prepare: okPrepared() as never } as never);
  assert.equal(result.kind, 'enforced');
  assert.equal(seen.confirms.length, 0);
});
