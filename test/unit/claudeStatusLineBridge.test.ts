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
        session_id: 'provider-private-id',
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
    assert.deepEqual(Object.keys(record).sort(), ['eventId', 'observedAt', 'schemaVersion', 'sequence', 'statusLine']);
    assert.deepEqual(record.statusLine, {
      model: { id: 'claude-sonnet-4-5' },
      cost: { total_cost_usd: 0.125 }
    });
    assert.doesNotMatch(JSON.stringify(record), /transcript|private|provider-private-id|cwd/);
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
