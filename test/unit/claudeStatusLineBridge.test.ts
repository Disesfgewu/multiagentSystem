import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { runBridge } from '../../src/accounts/claudeStatusLineBridge';

test('Claude status line bridge: extracts rate_limits and writes atomically', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-test-'));
  try {
    const quotaPath = path.join(tempDir, 'statusline-quota.json');
    const inputPayload = {
      model: { display_name: 'Claude 3.7 Sonnet' },
      rate_limits: {
        five_hour: { used_percentage: 24.5, resets_at: 1774999577 },
        seven_day: { used_percentage: 52.0, resets_at: 1775500000 }
      }
    };

    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const result = spawnSync('node', [bridgeScript, quotaPath], {
      input: JSON.stringify(inputPayload),
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Claude 3\.7 Sonnet \| 5h: 24\.5% \| 7d: 52%/);

    assert.equal(fs.existsSync(quotaPath), true);
    const content = JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
    assert.equal(content.model, 'Claude 3.7 Sonnet');
    assert.equal(content.rate_limits.five_hour.used_percentage, 24.5);
    assert.equal(content.rate_limits.seven_day.used_percentage, 52.0);
    assert.ok(content.observedAt);

    if (process.platform !== 'win32') {
      const stat = fs.statSync(quotaPath);
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude status line bridge: handles payload without rate_limits (non Pro/Max or initial session)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-test-'));
  try {
    const quotaPath = path.join(tempDir, 'statusline-quota.json');
    const inputPayload = {
      model: { display_name: 'Claude 3.7 Sonnet' }
    };

    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const result = spawnSync('node', [bridgeScript, quotaPath], {
      input: JSON.stringify(inputPayload),
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'Claude 3.7 Sonnet');

    assert.equal(fs.existsSync(quotaPath), true);
    const content = JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
    assert.equal(content.model, 'Claude 3.7 Sonnet');
    assert.equal(content.rate_limits, null);
    assert.ok(content.observedAt);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('managed session output contains only documented model and cost fields in its account directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-observation-'));
  try {
    const quotaPath = path.join(tempDir, 'statusline-quota.json');
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const result = spawnSync('node', [bridgeScript, quotaPath], {
      input: JSON.stringify({
        session_id: 'claude-own-7',
        transcript_path: '/private/transcript',
        cwd: '/private/project',
        model: { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet' },
        cost: { total_cost_usd: 0.125 },
        rate_limits: {}
      }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir, MULTIAGENT_CLAUDE_SESSION_ID: 'managed-session-1' }
    });
    assert.equal(result.status, 0);
    const file = path.join(tempDir, 'session-observations', 'managed-session-1.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['eventId', 'observedAt', 'providerSessionId', 'schemaVersion', 'sequence', 'statusLine']);
    assert.deepEqual(record.statusLine, {
      model: { id: 'claude-sonnet-4-5' },
      cost: { total_cost_usd: 0.125 }
    });
    assert.equal(record.providerSessionId, 'claude-own-7');
    assert.doesNotMatch(JSON.stringify(record), /transcript|private|cwd/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('untrusted session ids cannot select a path outside the account directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-boundary-'));
  try {
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const result = spawnSync('node', [bridgeScript, path.join(tempDir, 'quota.json')], {
      input: JSON.stringify({ model: { id: 'claude-sonnet-4-5' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir, MULTIAGENT_CLAUDE_SESSION_ID: '../escape' }
    });
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(path.join(tempDir, 'session-observations')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a provider session id without the documented shape is never written', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-id-shape-'));
  try {
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    for (const bad of ['../../etc/passwd', 'a b', 'x'.repeat(200), 12, '']) {
      spawnSync('node', [bridgeScript, path.join(tempDir, 'quota.json')], {
        input: JSON.stringify({ session_id: bad, model: { id: 'claude-sonnet-4-5' } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir, MULTIAGENT_CLAUDE_SESSION_ID: 'managed-session-3' }
      });
      const record = JSON.parse(fs.readFileSync(path.join(tempDir, 'session-observations', 'managed-session-3.json'), 'utf8'));
      assert.equal(Object.hasOwn(record, 'providerSessionId'), false, JSON.stringify(bad));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('the observation folder is private, and a symlinked one is never written through', { skip: process.platform === 'win32' }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-dir-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-elsewhere-'));
  try {
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const run = () => spawnSync('node', [bridgeScript, path.join(tempDir, 'quota.json')], {
      input: JSON.stringify({ model: { id: 'claude-sonnet-4-5' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir, MULTIAGENT_CLAUDE_SESSION_ID: 'managed-session-2' }
    });
    assert.equal(run().status, 0);
    const dir = path.join(tempDir, 'session-observations');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    fs.chmodSync(dir, 0o755);
    run();
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'an existing folder is tightened');
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(elsewhere, dir);
    assert.equal(run().status, 0);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing is written through the link');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('Claude status line bridge: fail-closed on corrupt or empty stdin', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-test-'));
  try {
    const quotaPath = path.join(tempDir, 'statusline-quota.json');
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');

    // Test corrupted JSON
    const resCorrupt = spawnSync('node', [bridgeScript, quotaPath], {
      input: 'not-json-content{{{',
      encoding: 'utf8'
    });
    assert.equal(resCorrupt.status, 0);
    assert.equal(fs.existsSync(quotaPath), false);

    // Test empty input
    const resEmpty = spawnSync('node', [bridgeScript, quotaPath], {
      input: '   \n  ',
      encoding: 'utf8'
    });
    assert.equal(resEmpty.status, 0);
    assert.equal(fs.existsSync(quotaPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude status line bridge: fail-closed on write failure', () => {
  const invalidPath = path.join('/nonexistent/root/dir/statusline-quota.json');
  const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');

  const result = spawnSync('node', [bridgeScript, invalidPath], {
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10 } } }),
    encoding: 'utf8'
  });

  // Must exit code 0 and never crash Claude Code
  assert.equal(result.status, 0);
});

test('bridge rejects oversized input in a single chunk and does not persist a valid prefix', async () => {
  const { PassThrough } = await import('node:stream');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-bound-'));
  const target = path.join(root, 'quota.json');
  try {
    for (const chunks of [
      [JSON.stringify({ padding: 'x'.repeat(70000), rate_limits: {} })],
      [JSON.stringify({ padding: '界'.repeat(22000), rate_limits: {} })],
      ['{"rate_limits":{}}', ' '.repeat(70000)]
    ]) {
      const input = new PassThrough(); const output = new PassThrough();
      runBridge([target], input as unknown as typeof process.stdin, output as unknown as typeof process.stdout);
      for (const chunk of chunks) input.emit('data', chunk);
      input.emit('end');
      assert.equal(fs.existsSync(target), false);
      assert.equal(output.read(), null);
      input.destroy(); output.destroy();
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude status line bridge: keeps every per-model weekly window, only its percent and reset time (#352)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-test-'));
  try {
    const quotaPath = path.join(tempDir, 'statusline-quota.json');
    const rateLimits: Record<string, unknown> = {
      five_hour: { used_percentage: 24.5, resets_at: 1774999577, note: 'dropped' },
      seven_day: { used_percentage: 52, resets_at: 1775500000 },
      seven_day_opus: { used_percentage: 71, resets_at: 1775500000, extra: 'dropped' },
      seven_day_sonnet: { used_percentage: 12, resets_at: 1775500000 },
      'seven_day_../x': { used_percentage: 1 },
      SEVEN_DAY_OPUS: { used_percentage: 2 },
      other_window: { used_percentage: 3 }
    };
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const result = spawnSync('node', [bridgeScript, quotaPath], { input: JSON.stringify({ rate_limits: rateLimits }), encoding: 'utf8' });
    assert.equal(result.status, 0);
    const content = JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
    assert.deepEqual(Object.keys(content.rate_limits).sort(), ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);
    assert.deepEqual(content.rate_limits.seven_day_opus, { used_percentage: 71, resets_at: 1775500000 });
    assert.deepEqual(content.rate_limits.five_hour, { used_percentage: 24.5, resets_at: 1774999577 });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude status line bridge: keeps at most eight windows however many the reading has (#352)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-test-'));
  try {
    const quotaPath = path.join(tempDir, 'statusline-quota.json');
    // The 5-hour and weekly windows come last in the reading, after twenty per-model ones.
    const rateLimits: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) rateLimits[`seven_day_model_${index}`] = { used_percentage: index, resets_at: 1775500000 };
    rateLimits.five_hour = { used_percentage: 1, resets_at: 1774999577 };
    rateLimits.seven_day = { used_percentage: 2, resets_at: 1775500000 };
    const bridgeScript = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
    const result = spawnSync('node', [bridgeScript, quotaPath], { input: JSON.stringify({ rate_limits: rateLimits }), encoding: 'utf8' });
    assert.equal(result.status, 0);
    const kept = Object.keys(JSON.parse(fs.readFileSync(quotaPath, 'utf8')).rate_limits);
    assert.equal(kept.length, 8);
    assert.ok(kept.includes('five_hour') && kept.includes('seven_day'), 'the 5-hour and weekly windows are always among them');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
