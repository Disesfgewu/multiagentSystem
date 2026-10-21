import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  STATUSLINE_QUOTA_FILE_NAME,
  buildBridgeCommand,
  getBridgeScriptPath,
  quotaUnknownReason,
  quotaObservations,
  readClaudeQuotaObservations
} from '../../src/accounts/claudeStatusLine';

const { describeQuota, UNKNOWN_REASONS } = require('../../src/accounts/quota-gate') as {
  describeQuota(observations: unknown[], now: Date, reason?: string | null): string[];
  UNKNOWN_REASONS: Record<string, { short: string; detail: string }>;
};

const NOW = new Date('2026-10-18T10:00:00.000Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

function fixture(setup: (dir: string, quotaPath: string) => void): { dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-reason-'));
  setup(dir, path.join(dir, STATUSLINE_QUOTA_FILE_NAME));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function enableBridgeSettings(dir: string, quotaPath: string): void {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: buildBridgeCommand(getBridgeScriptPath(), quotaPath) } }));
}

const goodLimits = { five_hour: { used_percentage: 30, resets_at: nowSeconds + 3600 } };

// Every case: exact reason code, exact wording, and no number anywhere in the output.
const CASES: Array<{ name: string; reason: string; setup: (dir: string, quotaPath: string) => void }> = [
  { name: 'settings missing (bridge never enabled)', reason: 'bridge-not-enabled', setup: () => {} },
  { name: 'settings without a statusLine', reason: 'bridge-not-enabled', setup: (dir) => fs.writeFileSync(path.join(dir, 'settings.json'), '{}') },
  { name: 'another statusLine command', reason: 'bridge-other-statusline', setup: (dir) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } })) },
  { name: 'settings unreadable', reason: 'bridge-state-unknown', setup: (dir) => fs.writeFileSync(path.join(dir, 'settings.json'), '{not json') },
  { name: 'bridge enabled, no data yet', reason: 'bridge-no-data', setup: enableBridgeSettings },
  { name: 'empty file', reason: 'file-unreadable', setup: (_d, q) => fs.writeFileSync(q, '') },
  { name: 'invalid JSON', reason: 'file-unreadable', setup: (_d, q) => fs.writeFileSync(q, '{oops') },
  { name: 'JSON array', reason: 'file-unreadable', setup: (_d, q) => fs.writeFileSync(q, '[]') },
  { name: 'oversized file', reason: 'file-unreadable', setup: (_d, q) => fs.writeFileSync(q, ' '.repeat(1024 * 1024 + 1)) },
  { name: 'directory instead of file', reason: 'file-unreadable', setup: (_d, q) => fs.mkdirSync(q) },
  { name: 'missing timestamp', reason: 'timestamp-invalid', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ rate_limits: goodLimits })) },
  { name: 'garbage timestamp', reason: 'timestamp-invalid', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: 'yesterday-ish', rate_limits: goodLimits })) },
  { name: 'future timestamp', reason: 'timestamp-future', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: '2026-10-18T10:00:01.000Z', rate_limits: goodLimits })) },
  { name: 'rate_limits absent', reason: 'rate-limits-absent', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: NOW.toISOString() })) },
  { name: 'rate_limits null', reason: 'rate-limits-absent', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: NOW.toISOString(), rate_limits: null })) },
  { name: 'reading older than its lifetime', reason: 'reading-expired', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: '2026-10-18T09:00:00.000Z', rate_limits: goodLimits })) },
  { name: 'window already reset when the reading was written', reason: 'window-reset-passed', setup: (_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: '2026-10-18T09:59:00.000Z', rate_limits: { five_hour: { used_percentage: 30, resets_at: nowSeconds - 120 } } })) }
];

for (const entry of CASES) {
  test(`unknown reason: ${entry.name} -> ${entry.reason}`, () => {
    const { dir, done } = fixture(entry.setup);
    try {
      const profile = { provider: 'claude', configDir: dir };
      assert.equal(quotaUnknownReason('p1', profile, NOW), entry.reason);
      const lines = describeQuota(quotaObservations('p1', profile, NOW), NOW, entry.reason);
      assert.equal(lines[0], `Usage: unknown (${UNKNOWN_REASONS[entry.reason].short}).`);
      assert.equal(lines[1], `Why: ${UNKNOWN_REASONS[entry.reason].detail}`);
      // Unknown is never turned into a number: the reason lines carry no percentage, and no window shows one.
      if (entry.reason === 'reading-expired') {
        // The old number may be listed for reference, but only labelled as not used.
        assert.match(lines.slice(2).join('\n'), /30% used, out of date \(not used to block\)/);
      } else {
        assert.equal(/\d+\s*%\s*used/.test(lines.join('\n')), false, lines.join('\n'));
        assert.equal(/\b(0|100)%/.test(lines.join('\n')), false);
      }
    } finally { done(); }
  });
}

test('a symlinked quota file is unsafe, not read', (t) => {
  const { dir, done } = fixture(() => {});
  try {
    const target = path.join(dir, 'real.json');
    fs.writeFileSync(target, JSON.stringify({ observedAt: NOW.toISOString(), rate_limits: goodLimits }));
    try { fs.symlinkSync(target, path.join(dir, STATUSLINE_QUOTA_FILE_NAME)); } catch { t.skip('symlinks unavailable'); return; }
    assert.deepEqual(readClaudeQuotaObservations('p1', dir, NOW), []);
    assert.equal(quotaUnknownReason('p1', { provider: 'claude', configDir: dir }, NOW), 'file-unreadable');
  } finally { done(); }
});

test('a current reading has no unknown reason and shows its number', () => {
  const { dir, done } = fixture((_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: NOW.toISOString(), rate_limits: goodLimits })));
  try {
    const profile = { provider: 'claude', configDir: dir };
    assert.equal(quotaUnknownReason('p1', profile, NOW), null);
    const lines = describeQuota(quotaObservations('p1', profile, NOW), NOW, 'bridge-no-data');
    assert.equal(lines.some((line) => line.startsWith('Usage: unknown')), false, 'a stale reason never sits beside a number');
    assert.match(lines[0], /^Usage \(five_hour\): 30% used, verified and current, resets in 1h\./);
  } finally { done(); }
});

test('providers without a verified source say so by name, whatever is on disk (Codex reads its own session log, so it says what that log lacks)', () => {
  const { dir, done } = fixture((_d, q) => fs.writeFileSync(q, JSON.stringify({ observedAt: NOW.toISOString(), rate_limits: goodLimits })));
  try {
    assert.equal(quotaUnknownReason('a', { provider: 'agy', configDir: dir }, NOW), 'no-source-agy');
    assert.equal(quotaUnknownReason('c', { provider: 'codex', configDir: dir }, NOW), 'codex-no-sessions', 'a Claude quota file is not a Codex log, and there is no sessions folder here');
    assert.equal(quotaUnknownReason('o', { provider: 'opencode', configDir: dir }, NOW), 'no-source-provider');
    assert.deepEqual(quotaObservations('a', { provider: 'agy', configDir: dir }, NOW), []);
    assert.equal(quotaUnknownReason('missing', undefined, NOW), null);
  } finally { done(); }
});

test('inferred reasons are worded as likely, observed ones are not', () => {
  for (const code of ['bridge-no-data', 'rate-limits-absent']) assert.match(UNKNOWN_REASONS[code].detail, /\blikely\b/i, code);
  for (const code of ['timestamp-future', 'timestamp-invalid', 'file-unreadable', 'bridge-not-enabled']) assert.doesNotMatch(UNKNOWN_REASONS[code].detail, /\blikely\b/i, code);
});

test('an unrecognised reason code is ignored and the generic sentence stays', () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'nope', 7, null, undefined, {}]) {
    const lines = describeQuota([], NOW, bad as any);
    assert.match(lines[0], /^Usage: unknown\. No verified usage source/, String(bad));
  }
});

test('every reason code in the table is produced by some case (dropping one fails here)', () => {
  const produced = new Set(CASES.map((entry) => entry.reason));
  // Produced by the Codex log reader (test/accounts/codex-rate-limits.test.js and test/unit/codexQuotaWiring.test.ts), not by a Claude quota file.
  for (const code of ['no-source-agy', 'no-source-provider', 'codex-no-sessions', 'codex-no-events', 'codex-format-changed', 'codex-reading-expired']) produced.add(code);
  assert.deepEqual([...produced].sort(), Object.keys(UNKNOWN_REASONS).sort());
});
