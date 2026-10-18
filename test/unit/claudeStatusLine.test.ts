import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  getBridgeScriptPath,
  buildBridgeCommand,
  inspectStatusLineConfig,
  enableStatusLineBridge,
  disableStatusLineBridge,
  readClaudeQuotaFile,
  readClaudeQuotaObservations,
  registerProfileForQuota,
  quotaObservations,
  configureStatusLineWizard,
  STATUSLINE_QUOTA_FILE_NAME
} from '../../src/accounts/claudeStatusLine';

test('Claude status line: bridge script path resolution and command building', () => {
  const scriptPath = getBridgeScriptPath();
  assert.equal(fs.existsSync(scriptPath), true);
  assert.match(scriptPath, /claudeStatusLineBridge\.js$/);

  const command = buildBridgeCommand('/path/to/bridge.js', '/path/to/quota.json');
  assert.equal(command, 'node "/path/to/bridge.js" "/path/to/quota.json"');
});

test('Claude status line inspection: detects disabled, active, custom, and unreadable configurations', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-inspect-'));
  try {
    const bridgeScript = getBridgeScriptPath();

    // 1. No settings.json -> disabled
    const emptyInspection = inspectStatusLineConfig(tempDir, bridgeScript);
    assert.equal(emptyInspection.status, 'disabled');
    assert.equal(emptyInspection.hasQuotaFile, false);

    // 2. settings.json without statusLine -> disabled, preserves existing settings
    fs.writeFileSync(path.join(tempDir, 'settings.json'), JSON.stringify({ theme: 'dark', autoUpdate: false }));
    const noStatusLine = inspectStatusLineConfig(tempDir, bridgeScript);
    assert.equal(noStatusLine.status, 'disabled');
    assert.equal(noStatusLine.existingSettings?.theme, 'dark');

    // 3. settings.json with Multiagent bridge -> active
    enableStatusLineBridge(tempDir, bridgeScript);
    const active = inspectStatusLineConfig(tempDir, bridgeScript);
    assert.equal(active.status, 'active');
    assert.equal(active.existingSettings?.theme, 'dark');

    // 4. settings.json with custom user command -> custom
    fs.writeFileSync(path.join(tempDir, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'echo "hello"' }
    }));
    const custom = inspectStatusLineConfig(tempDir, bridgeScript);
    assert.equal(custom.status, 'custom');
    assert.equal(custom.currentCommand, 'echo "hello"');

    // 5. Invalid JSON in settings.json -> unreadable
    fs.writeFileSync(path.join(tempDir, 'settings.json'), '{ invalid json');
    const unreadable = inspectStatusLineConfig(tempDir, bridgeScript);
    assert.equal(unreadable.status, 'unreadable');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude status line: enable and disable manage settings.json and quota file preserving other settings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-manage-'));
  try {
    const bridgeScript = getBridgeScriptPath();
    const settingsPath = path.join(tempDir, 'settings.json');
    const quotaPath = path.join(tempDir, STATUSLINE_QUOTA_FILE_NAME);

    // Initial settings with custom user preferences
    fs.writeFileSync(settingsPath, JSON.stringify({ preferredModel: 'claude-3-7-sonnet', customEnv: { FOO: 'bar' } }, null, 2));

    // Enable bridge
    const enableResult = enableStatusLineBridge(tempDir, bridgeScript);
    assert.equal(enableResult.ok, true);

    const afterEnable = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(afterEnable.preferredModel, 'claude-3-7-sonnet');
    assert.equal(afterEnable.customEnv.FOO, 'bar');
    assert.ok(afterEnable.statusLine?.command.includes('claudeStatusLineBridge.js'));

    if (process.platform !== 'win32') {
      const stat = fs.statSync(settingsPath);
      assert.equal(stat.mode & 0o777, 0o600);
    }

    // Create a dummy quota file
    fs.writeFileSync(quotaPath, JSON.stringify({ rate_limits: {} }));
    assert.equal(fs.existsSync(quotaPath), true);

    // Disable bridge
    const disableResult = disableStatusLineBridge(tempDir);
    assert.equal(disableResult.ok, true);

    const afterDisable = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(afterDisable.preferredModel, 'claude-3-7-sonnet');
    assert.equal(afterDisable.customEnv.FOO, 'bar');
    assert.equal(afterDisable.statusLine, undefined);
    assert.equal(fs.existsSync(quotaPath), false, 'clears local quota file on disable');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude quota observations: reads valid, null, expired, and absent rate limits honestly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-obs-'));
  try {
    const quotaPath = path.join(tempDir, STATUSLINE_QUOTA_FILE_NAME);
    const now = new Date('2026-10-18T10:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);

    // 1. Missing file -> returns []
    assert.deepEqual(readClaudeQuotaObservations('p1', tempDir, now), []);

    // 2. Valid file with 5h and 7d rate limits
    fs.writeFileSync(quotaPath, JSON.stringify({
      observedAt: now.toISOString(),
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: nowSeconds + 3600 },
        seven_day: { used_percentage: 65, resets_at: nowSeconds + 86400 }
      }
    }));
    const validObs = readClaudeQuotaObservations('p1', tempDir, now);
    const byField = Object.fromEntries(validObs.map((entry: any) => [entry.field, entry]));
    assert.equal(byField['quota.five_hour.used_percent'].value, 30);
    assert.equal(byField['quota.five_hour.used_percent'].confidence, 'actual');
    assert.equal(byField['quota.seven_day.used_percent'].value, 65);
    assert.equal(byField['quota.seven_day.used_percent'].confidence, 'actual');

    // 3. File with rate_limits: null (non Pro/Max account or before first API call)
    fs.writeFileSync(quotaPath, JSON.stringify({
      observedAt: now.toISOString(),
      rate_limits: null
    }));
    const nullObs = readClaudeQuotaObservations('p1', tempDir, now);
    assert.equal(nullObs.length, 4);
    assert.equal(nullObs.every((entry: any) => entry.value === null && entry.confidence === 'unknown'), true);
    assert.match((nullObs[0] as any).reason, /^rate_limits-absent/);

    // 4. File where reset has already passed -> marked window-reset-passed
    fs.writeFileSync(quotaPath, JSON.stringify({
      observedAt: now.toISOString(),
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: nowSeconds - 100 }
      }
    }));
    const expiredObs = readClaudeQuotaObservations('p1', tempDir, now);
    const expiredMap = Object.fromEntries(expiredObs.map((entry: any) => [entry.field, entry]));
    assert.equal(expiredMap['quota.five_hour.used_percent'].value, null);
    assert.equal(expiredMap['quota.five_hour.used_percent'].reason, 'window-reset-passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude status line wizard: rejects non-Claude accounts and enforces explicit user consent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wizard-test-'));
  try {
    // 1. Non-Claude provider (Codex) -> rejected with unsupported, never touches configDir
    const codexProfile = { id: 'codex-1', provider: 'codex', label: 'My Codex', configDir: tempDir };
    const codexRes = await configureStatusLineWizard(codexProfile, { interactive: false });
    assert.equal(codexRes.ok, false);
    assert.equal(codexRes.status, 'unsupported');
    assert.match(codexRes.message, /only supported for Claude Code accounts/);
    assert.equal(fs.existsSync(path.join(tempDir, 'settings.json')), false);

    // 2. Non-Claude provider (agy) -> rejected
    const agyProfile = { id: 'agy-1', provider: 'agy', label: 'My Agy', configDir: tempDir };
    const agyRes = await configureStatusLineWizard(agyProfile, { interactive: false });
    assert.equal(agyRes.ok, false);
    assert.equal(agyRes.status, 'unsupported');

    // 3. Claude profile without consent -> cancelled, never writes settings.json
    const claudeProfile = { id: 'claude-1', provider: 'claude', label: 'My Claude', configDir: tempDir };
    const cancelRes = await configureStatusLineWizard(claudeProfile, { interactive: false, consent: false });
    assert.equal(cancelRes.ok, false);
    assert.equal(cancelRes.status, 'cancelled');
    assert.equal(fs.existsSync(path.join(tempDir, 'settings.json')), false);

    // 4. Claude profile with explicit consent -> enabled, writes settings.json
    const enableRes = await configureStatusLineWizard(claudeProfile, { interactive: false, consent: true });
    assert.equal(enableRes.ok, true);
    assert.equal(enableRes.status, 'enabled');
    assert.equal(fs.existsSync(path.join(tempDir, 'settings.json')), true);

    // 5. Claude profile disable action -> disabled
    const disableRes = await configureStatusLineWizard(claudeProfile, { interactive: false, consent: true, action: 'disable' });
    assert.equal(disableRes.ok, true);
    assert.equal(disableRes.status, 'disabled');
    const settings = JSON.parse(fs.readFileSync(path.join(tempDir, 'settings.json'), 'utf8'));
    assert.equal(settings.statusLine, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Quota gate integration: feeds real Claude status line readings and leaves Codex/agy unknown', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-gate-test-'));
  try {
    const quotaPath = path.join(tempDir, STATUSLINE_QUOTA_FILE_NAME);
    const now = new Date('2026-10-18T10:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);

    // 1. Claude profile with active quota
    fs.writeFileSync(quotaPath, JSON.stringify({
      observedAt: now.toISOString(),
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: nowSeconds + 3600 }
      }
    }));
    registerProfileForQuota({ id: 'prof-claude', provider: 'claude', configDir: tempDir });

    const claudeObs = quotaObservations('prof-claude', undefined, now);
    assert.equal(claudeObs.length, 4);
    const fiveHour = claudeObs.find((item: any) => item.field === 'quota.five_hour.used_percent') as any;
    assert.equal(fiveHour?.value, 42);
    assert.equal(fiveHour?.confidence, 'actual');

    // 2. Codex profile with SAME directory -> strictly returns [] (quota remains unknown)
    registerProfileForQuota({ id: 'prof-codex', provider: 'codex', configDir: tempDir });
    const codexObs = quotaObservations('prof-codex', undefined, now);
    assert.deepEqual(codexObs, [], 'Codex quota is never read from status line');

    // 3. agy profile -> strictly returns []
    registerProfileForQuota({ id: 'prof-agy', provider: 'agy', configDir: tempDir });
    const agyObs = quotaObservations('prof-agy', undefined, now);
    assert.deepEqual(agyObs, [], 'agy quota is never read from status line');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
