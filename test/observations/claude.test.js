'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionObservationCore, USAGE_FIELDS } = require('../../src/observations/session');
const {
  createClaudeSessionEvidenceAdapter,
  createClaudeHookEvidenceAdapter,
  deriveClaudeHookState,
  extractClaudeStatusLineUsage,
  CLAUDE_SOURCE,
  CLAUDE_HOOK_SOURCE,
  CLAUDE_STATUSLINE_SOURCE,
  CLAUDE_HOOK_STATES
} = require('../../src/observations/claude');

const START = '2026-01-01T00:00:00.000Z';
const binding = { sessionId: 'session-c1', provider: 'claude', accountProfileId: 'account-c1' };

function setup(claudeSessionId = 'claude-sess-1') {
  const core = new SessionObservationCore({ now: () => START, ttlMs: 1000 });
  core.register(binding);
  const sessionAdapter = createClaudeSessionEvidenceAdapter({
    core,
    sessionId: binding.sessionId,
    accountProfileId: binding.accountProfileId
  });
  const hookAdapter = createClaudeHookEvidenceAdapter({
    core,
    sessionId: binding.sessionId,
    accountProfileId: binding.accountProfileId,
    claudeSessionId
  });
  return { core, sessionAdapter, hookAdapter };
}

test('deriveClaudeHookState maps documented Claude hook events and fails closed on unknown', () => {
  assert.equal(deriveClaudeHookState('UserPromptSubmit'), 'working');
  assert.equal(deriveClaudeHookState('PreToolUse'), 'working');
  assert.equal(deriveClaudeHookState('PostToolUse'), 'working');
  assert.equal(deriveClaudeHookState('Notification'), 'waiting');
  assert.equal(deriveClaudeHookState('Stop'), 'waiting');
  assert.equal(deriveClaudeHookState('SessionEnd'), 'ended');

  assert.equal(deriveClaudeHookState('RandomEvent'), null);
  assert.equal(deriveClaudeHookState(''), null);
  assert.equal(deriveClaudeHookState(null), null);
  assert.equal(deriveClaudeHookState(123), null);
});

test('extractClaudeStatusLineUsage parses official Claude statusLine payload', () => {
  const payload = {
    model: { id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' },
    cost: { total_cost_usd: 0.045 },
    context_window: {
      total_input_tokens: 12000,
      total_output_tokens: 650,
      context_window_size: 200000,
      current_usage: {
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1500
      }
    }
  };

  const extracted = extractClaudeStatusLineUsage(payload);
  assert.equal(extracted.model, 'claude-3-7-sonnet-20250219');
  const usageMap = Object.fromEntries(extracted.usage.map(u => [u.field, u]));
  assert.deepEqual(usageMap['usage.cost_usd'], {
    field: 'usage.cost_usd',
    value: 0.045,
    measurement: 'estimated',
    scope: 'session-cumulative'
  });
  // context_window tokens are not session-cumulative; they are kept unknown
  assert.equal(usageMap['usage.input_tokens'], undefined);
  assert.equal(usageMap['usage.output_tokens'], undefined);
  assert.equal(usageMap['usage.cache_read_tokens'], undefined);
  assert.equal(usageMap['usage.cache_write_tokens'], undefined);
});

test('extractClaudeStatusLineUsage fails closed on malformed input', () => {
  assert.equal(extractClaudeStatusLineUsage(null), null);
  assert.equal(extractClaudeStatusLineUsage('not an object'), null);
  assert.equal(extractClaudeStatusLineUsage([]), null);
});

test('hook adapter derives working and waiting states from official notifications', () => {
  const { core, hookAdapter } = setup('claude-sess-1');

  // PreToolUse -> working
  const toolResult = hookAdapter.accept({
    eventId: 'evt-1',
    observedAt: START,
    sequence: 1,
    notification: {
      sessionId: 'claude-sess-1',
      hookEventName: 'PreToolUse'
    }
  });
  assert.deepEqual(toolResult, { ok: true, reason: 'accepted', accepted: true });
  assert.equal(core.snapshot('session-c1', START).status.value, 'working');
  assert.equal(core.snapshot('session-c1', START).status.source, CLAUDE_HOOK_SOURCE);

  // Stop -> waiting
  const stopResult = hookAdapter.accept({
    eventId: 'evt-2',
    observedAt: START,
    sequence: 2,
    notification: {
      sessionId: 'claude-sess-1',
      hookEventName: 'Stop'
    }
  });
  assert.deepEqual(stopResult, { ok: true, reason: 'accepted', accepted: true });
  assert.equal(core.snapshot('session-c1', START).status.value, 'waiting');
});

test('hook adapter rejects mismatched claudeSessionId and unknown events', () => {
  const { core, hookAdapter } = setup('claude-sess-1');

  // Mismatch
  const mismatch = hookAdapter.accept({
    eventId: 'evt-1',
    observedAt: START,
    sequence: 1,
    notification: {
      sessionId: 'claude-sess-OTHER',
      hookEventName: 'PreToolUse'
    }
  });
  assert.equal(mismatch.reason, 'session-binding-mismatch');

  // Unknown hook event
  const unknownEvt = hookAdapter.accept({
    eventId: 'evt-2',
    observedAt: START,
    sequence: 2,
    notification: {
      sessionId: 'claude-sess-1',
      hookEventName: 'CustomUndocumentedEvent'
    }
  });
  assert.equal(unknownEvt.reason, 'claude-state-unknown');
  assert.equal(core.snapshot('session-c1', START).status.confidence, 'unknown');
});

test('hook adapter rejects raw CLI text and transcript content', () => {
  const { hookAdapter } = setup('claude-sess-1');
  assert.equal(hookAdapter.accept('claude output string').reason, 'claude-evidence-invalid');
  assert.equal(hookAdapter.accept({
    eventId: 'evt-1',
    observedAt: START,
    sequence: 1,
    transcript: '/path/to/transcript.jsonl',
    notification: { sessionId: 'claude-sess-1', hookEventName: 'PreToolUse' }
  }).reason, 'claude-evidence-invalid');
});

test('createClaudeSessionEvidenceAdapter accepts statusLine usage and hook event', () => {
  const { core, sessionAdapter } = setup();

  const res = sessionAdapter.accept({
    eventId: 'evt-sl-1',
    observedAt: START,
    sequence: 1,
    state: 'working',
    statusLine: {
      model: { id: 'claude-3-5-sonnet-20241022' },
      cost: { total_cost_usd: 0.02 },
      context_window: { total_input_tokens: 1500, total_output_tokens: 200 }
    }
  });
  assert.deepEqual(res, { ok: true, reason: 'accepted', accepted: true });

  const snap = core.snapshot('session-c1', START);
  assert.equal(snap.status.value, 'working');
  assert.equal(snap.status.source, CLAUDE_STATUSLINE_SOURCE);
  assert.equal(snap.model.value, 'claude-3-5-sonnet-20241022');
  const usageMap = Object.fromEntries(snap.usage.map(u => [u.field, u]));
  assert.equal(usageMap['usage.cost_usd'].value, 0.02);
  assert.equal(usageMap['usage.cost_usd'].confidence, 'estimated');
  assert.equal(usageMap['usage.cost_usd'].source, `${CLAUDE_STATUSLINE_SOURCE}.local-estimate`);
  assert.equal(usageMap['usage.input_tokens'].confidence, 'unknown');
});

test('createClaudeSessionEvidenceAdapter rejects conflicting caller fields when statusLine or hook is supplied', () => {
  const { sessionAdapter } = setup();

  // statusLine + usage is rejected
  assert.equal(sessionAdapter.accept({
    eventId: 'evt-c1', observedAt: START, sequence: 1,
    usage: [{ field: 'usage.cost_usd', value: 0.01, measurement: 'estimated', scope: 'session-cumulative' }],
    statusLine: { model: { id: 'claude-3-5-sonnet-20241022' } }
  }).reason, 'claude-evidence-invalid');

  // statusLine + model is rejected
  assert.equal(sessionAdapter.accept({
    eventId: 'evt-c2', observedAt: START, sequence: 2,
    model: 'claude-3-5-sonnet-20241022',
    statusLine: { cost: { total_cost_usd: 0.01 } }
  }).reason, 'claude-evidence-invalid');

  // hook + state is rejected
  assert.equal(sessionAdapter.accept({
    eventId: 'evt-c3', observedAt: START, sequence: 3,
    state: 'working',
    hook: { sessionId: 'session-c1', hookEventName: 'PreToolUse' }
  }).reason, 'claude-evidence-invalid');
});

test('hook adapter accepts official snake_case notification and discards extraneous fields', () => {
  const { core, hookAdapter } = setup('claude-sess-1');

  const res = hookAdapter.accept({
    eventId: 'evt-snake-1',
    observedAt: START,
    sequence: 1,
    notification: {
      session_id: 'claude-sess-1',
      hook_event_name: 'PreToolUse',
      transcript_path: '/secret/transcript.jsonl',
      cwd: '/secret/cwd',
      prompt_id: 'prompt-123'
    }
  });
  assert.deepEqual(res, { ok: true, reason: 'accepted', accepted: true });
  const snap = core.snapshot('session-c1', START);
  assert.equal(snap.status.value, 'working');
  // Ensure private fields (transcript_path, cwd, prompt_id) are NOT passed or stored in snapshot
  assert.equal(snap.transcript_path, undefined);
  assert.equal(snap.cwd, undefined);
  assert.equal(snap.prompt_id, undefined);
});

test('parameter validation throws TypeError on invalid arguments for hook adapter', () => {
  const core = new SessionObservationCore({ now: () => START });
  assert.throws(() => createClaudeHookEvidenceAdapter(), /core\.ingest is required/);
  assert.throws(() => createClaudeHookEvidenceAdapter({ core }), /sessionId is required/);
  assert.throws(() => createClaudeHookEvidenceAdapter({ core, sessionId: 's1' }), /accountProfileId is required/);
  assert.throws(() => createClaudeHookEvidenceAdapter({ core, sessionId: 's1', accountProfileId: 'a1' }), /claudeSessionId is required/);
});
