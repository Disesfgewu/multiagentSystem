import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { quotaObservations, quotaUnknownReason, codexQuotaReading } from '../../src/accounts/claudeStatusLine';

const { describeQuota } = require('../../src/accounts/quota-gate') as { describeQuota(observations: unknown[], now: Date, reason?: string | null): string[] };
const NOW = new Date('2026-10-21T10:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const epoch = (minutes: number) => Math.floor((NOW.getTime() + minutes * 60_000) / 1000);

function home(lines: string[]): { dir: string; done: () => void } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-codex-wiring-')));
  const folder = path.join(dir, 'sessions', '2026', '10', '21');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'rollout-2026-10-21T09-00-00-abcd1234.jsonl'), `${lines.join('\n')}\n`);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const event = (minutesAgo: number, primary: unknown, secondary: unknown = { used_percent: 10, window_minutes: 10080, resets_at: epoch(60 * 24 * 3) }) => JSON.stringify({
  timestamp: at(minutesAgo), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary, secondary, plan_type: 'plus' } }
});

test('a Codex account shows both windows from its own session log, with the plan, and no unknown reason beside them', () => {
  const { dir, done } = home([event(1, { used_percent: 42, window_minutes: 300, resets_at: epoch(120) })]);
  try {
    const profile = { provider: 'codex', configDir: dir };
    assert.equal(quotaUnknownReason('c', profile, NOW), null);
    const lines = describeQuota(quotaObservations('c', profile, NOW), NOW, null);
    assert.match(lines[0], /^Usage \(five_hour\): 42% used, verified and current, resets in 2h\./);
    assert.ok(lines.some((line) => /^Usage \(seven_day\): 10% used/.test(line)));
    assert.match(lines.join('\n'), /codex session log rate_limits/, 'the source is named');
    assert.equal(codexQuotaReading('c', dir, NOW).planType, 'plus');
  } finally { done(); }
});

test('an old Codex reading is listed as out of date, a reset window as reset, and nothing is shown as a current number', () => {
  const stale = home([event(90, { used_percent: 42, window_minutes: 300, resets_at: epoch(120) })]);
  const reset = home([event(1, { used_percent: 99, window_minutes: 300, resets_at: epoch(-5) }, { used_percent: 5, window_minutes: 1440, resets_at: epoch(60) })]);
  try {
    assert.equal(quotaUnknownReason('c', { provider: 'codex', configDir: stale.dir }, NOW), 'codex-reading-expired');
    assert.match(describeQuota(quotaObservations('c', { provider: 'codex', configDir: stale.dir }, NOW), NOW, 'codex-reading-expired').join('\n'), /out of date \(not used to block\)/);
    assert.equal(quotaUnknownReason('c', { provider: 'codex', configDir: reset.dir }, NOW), 'window-reset-passed');
  } finally { stale.done(); reset.done(); }
});

test('a log that holds no usage, or one in a form that is not recognized, says exactly that', () => {
  const none = home([JSON.stringify({ timestamp: at(1), type: 'response_item', payload: { type: 'message' } })]);
  const changed = home([event(1, { used_percent: 5, window_minutes: 60, resets_at: epoch(60) }, { used_percent: 6, window_minutes: 1440, resets_at: epoch(60) })]);
  try {
    assert.equal(quotaUnknownReason('c', { provider: 'codex', configDir: none.dir }, NOW), 'codex-no-events');
    assert.equal(quotaUnknownReason('c', { provider: 'codex', configDir: changed.dir }, NOW), 'codex-format-changed');
    assert.deepEqual(quotaObservations('c', { provider: 'codex', configDir: none.dir }, NOW), []);
    assert.match(describeQuota([], NOW, 'codex-no-events').join('\n'), /Usage: unknown \(no usage in the Codex log yet\)/);
  } finally { none.done(); changed.done(); }
});

test('the other providers are unchanged: agy and others stay unknown, and a Codex reading never leaks into them', () => {
  const { dir, done } = home([event(1, { used_percent: 42, window_minutes: 300, resets_at: epoch(120) })]);
  try {
    assert.equal(quotaUnknownReason('a', { provider: 'agy', configDir: dir }, NOW), 'no-source-agy');
    assert.deepEqual(quotaObservations('a', { provider: 'agy', configDir: dir }, NOW), []);
    assert.deepEqual(quotaObservations('o', { provider: 'opencode', configDir: dir }, NOW), []);
  } finally { done(); }
});
