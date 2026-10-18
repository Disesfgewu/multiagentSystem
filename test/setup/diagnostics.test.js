'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_VSCODE_VERSION,
  MIN_NODE_MAJOR,
  checkRuntimeVersions,
  classifyManagedTool,
  summarizeAccountReadiness,
  diagnose,
  formatDiagnosticReport
} = require('../../src/setup/diagnostics');

test('checkRuntimeVersions enforces VS Code >= 1.95.0 and Node >= 20', () => {
  const ok = checkRuntimeVersions({ vscodeVersion: '1.95.0', nodeVersion: 'v20.11.1' });
  assert.equal(ok.vscodeOk, true);
  assert.equal(ok.nodeOk, true);
  assert.equal(ok.vscodeVersion, '1.95.0');
  assert.equal(ok.nodeVersion, '20.11.1');

  const oldVscode = checkRuntimeVersions({ vscodeVersion: '1.94.2', nodeVersion: '22.1.0' });
  assert.equal(oldVscode.vscodeOk, false);
  assert.equal(oldVscode.nodeOk, true);

  const oldNode = checkRuntimeVersions({ vscodeVersion: '1.96.0-insider', nodeVersion: '18.19.0' });
  assert.equal(oldNode.vscodeOk, true);
  assert.equal(oldNode.nodeOk, false);

  const invalid = checkRuntimeVersions({ vscodeVersion: 'invalid', nodeVersion: null });
  assert.equal(invalid.vscodeOk, false);
  assert.equal(invalid.nodeOk, false);
  assert.equal(invalid.vscodeVersion, 'unknown');
  assert.equal(invalid.nodeVersion, 'unknown');
});

test('classifyManagedTool distinguishes first-use-pending, download/integrity failure, unsupported, and ready', () => {
  assert.deepEqual(classifyManagedTool({ state: 'ready', version: '2.102.0' }), {
    state: 'ready',
    category: 'ready',
    reason: null,
    version: '2.102.0'
  });

  assert.deepEqual(classifyManagedTool({ state: 'missing', reason: 'not-installed' }), {
    state: 'missing',
    category: 'first-use-pending',
    reason: 'not-installed',
    version: null
  });

  assert.deepEqual(classifyManagedTool({ state: 'missing', reason: 'checksum-mismatch' }), {
    state: 'missing',
    category: 'download-or-integrity-failed',
    reason: 'checksum-mismatch',
    version: null
  });

  assert.deepEqual(classifyManagedTool({ state: 'unsupported', reason: 'linux-arm64' }), {
    state: 'unsupported',
    category: 'platform-unsupported',
    reason: 'linux-arm64',
    version: null
  });
});

test('diagnose produces actionable codes and omits private labels, paths, and secrets', () => {
  const secretPath = '/Users/alice/.multiagent/private-profile-dir';
  const secretLabel = 'Alice Personal Pro Account';
  const profiles = [
    { id: 'prof-1', provider: 'claude', label: secretLabel, configDir: secretPath },
    { id: 'prof-2', provider: 'codex', label: 'Work Codex', configDir: '/Users/alice/.codex-work' }
  ];
  const observations = new Map([
    [
      'prof-1',
      {
        validation: { ok: true, problems: [] },
        blockers: [],
        identity: {
          loggedIn: false,
          authMethod: null,
          apiProvider: null,
          configDirMatches: true,
          anomalies: [],
          subject: { confidence: 'unknown', reason: 'not-logged-in' }
        }
      }
    ],
    [
      'prof-2',
      {
        validation: { ok: true, problems: [] },
        blockers: [],
        identity: {
          loggedIn: true,
          authMethod: 'oauth',
          apiProvider: 'openai',
          configDirMatches: true,
          anomalies: [],
          subject: { confidence: 'unknown', reason: 'cli-did-not-report-principal' }
        }
      }
    ]
  ]);

  const report = diagnose({
    vscodeVersion: '1.95.0',
    nodeVersion: '20.12.0',
    storageStatus: {
      state: 'available',
      reason: null,
      problems: [],
      secrets: 'reachable',
      coverage: { level: 'ancestors-checked', folders: 1, repositoriesFound: 1 }
    },
    storeStatus: {
      ok: true,
      reason: null,
      detail: null,
      schemaVersion: 2,
      onDiskVersion: 1,
      pendingMigration: true
    },
    lockStatus: {
      ok: true,
      held: true,
      stale: true
    },
    maskedExport: {
      ok: true,
      export: {
        format: 'multiagent-private-store-masked',
        schemaVersion: 2,
        exportedAt: '2026-10-17T12:00:00.000Z',
        collections: {
          profiles: {
            count: 2,
            records: [
              { alias: 'profiles#1', fields: { provider: 'claude', label: '<string>', configDir: '<string>' } },
              { alias: 'profiles#2', fields: { provider: 'codex', label: '<string>', configDir: '<string>' } }
            ]
          }
        }
      }
    },
    profiles,
    observations,
    executables: { git: true, gh: false, claude: true, codex: false, agy: false },
    managedTools: {
      gh: { state: 'missing', reason: 'checksum-mismatch' },
      codex: { state: 'ready', version: '0.163.0' },
      claude: { state: 'ready', version: '2.1.89' }
    },
    now: () => Date.parse('2026-10-17T12:00:00.000Z')
  });

  assert.equal(report.overall, 'error');
  const codes = report.actions.map((item) => item.code);
  assert.ok(codes.includes('storage-migration-pending'));
  assert.ok(codes.includes('storage-lock-stale'));
  assert.ok(codes.includes('tool-gh-download-or-integrity-failed'));
  assert.ok(codes.includes('provider-cli-missing:agy'));
  assert.ok(codes.includes('accounts-not-logged-in'));
  assert.ok(codes.includes('accounts-identity-unverified'));

  // Verify agy capabilities are honestly reported (terminalLaunch unverified, others unknown)
  const agy = report.providers.find((p) => p.id === 'agy');
  assert.ok(agy);
  assert.equal(agy.capabilities.terminalLaunch, 'unverified');
  assert.equal(agy.capabilities.accountIsolation, 'unknown');
  assert.equal(agy.capabilities.identityVerification, 'unknown');
  assert.equal(report.tools.managedAgy.state, 'unsupported');
  assert.equal(report.tools.managedAgy.category, 'platform-unsupported');

  // Verify codex is marked available via managedReady even when not on PATH
  const codex = report.providers.find((p) => p.id === 'codex');
  assert.equal(codex.executableOnPath, false);
  assert.equal(codex.managedReady, true);
  assert.equal(codex.cliAvailable, true);

  // Verify claude is marked available via managedReady
  const claude = report.providers.find((p) => p.id === 'claude');
  assert.equal(claude.managedReady, true);
  assert.equal(claude.cliAvailable, true);

  // Format report and verify zero private leakage
  const formatted = formatDiagnosticReport(report);
  assert.equal(formatted.includes(secretPath), false, 'no local path in diagnostic output');
  assert.equal(formatted.includes(secretLabel), false, 'no account label in diagnostic output');
  assert.equal(formatted.includes('prof-1'), false, 'no profile ID in diagnostic output');
  assert.match(formatted, /profiles#1/);
  assert.match(formatted, /storage-migration-pending/);
  assert.match(formatted, /- agy \(managed\): unsupported/);
});

test('diagnose flags corrupt store and recommends clearStorage recovery', () => {
  const report = diagnose({
    vscodeVersion: '1.95.0',
    nodeVersion: '20.11.0',
    storageStatus: { state: 'available', reason: null, problems: [], secrets: 'not-checked', coverage: null },
    storeStatus: { ok: false, reason: 'corrupt-store', detail: null, schemaVersion: 1, onDiskVersion: null, pendingMigration: false },
    lockStatus: { ok: true, held: false, stale: false },
    executables: { git: true, gh: true, claude: true, codex: true, agy: true },
    managedTools: { gh: { state: 'ready', version: '2.102.0' }, codex: { state: 'ready', version: '0.163.0' }, claude: { state: 'ready', version: '2.1.89' } }
  });

  assert.equal(report.overall, 'error');
  const corruptAction = report.actions.find((a) => a.code === 'store-unusable:corrupt-store');
  assert.ok(corruptAction);
  assert.equal(corruptAction.command, 'multiagentSystem.setup.clearStorage');
});

test('diagnose flags failed Claude download or integrity check and provides retryClaude action', () => {
  const report = diagnose({
    vscodeVersion: '1.95.0',
    nodeVersion: '20.11.0',
    storageStatus: { state: 'available', reason: null, problems: [], secrets: 'reachable', coverage: null },
    storeStatus: { ok: true, reason: null, detail: null, schemaVersion: 2, onDiskVersion: 2, pendingMigration: false },
    lockStatus: { ok: true, held: false, stale: false },
    executables: { git: true, gh: true, claude: false, codex: true, agy: true },
    managedTools: {
      gh: { state: 'ready', version: '2.102.0' },
      codex: { state: 'ready', version: '0.163.0' },
      claude: { state: 'missing', reason: 'archive-integrity-failed' }
    }
  });

  assert.equal(report.overall, 'error');
  const claudeAction = report.actions.find((a) => a.code === 'tool-claude-download-or-integrity-failed');
  assert.ok(claudeAction);
  assert.equal(claudeAction.command, 'multiagentSystem.setup.retryClaude');
  assert.match(claudeAction.summary, /archive-integrity-failed/);
});

test('free text reaching a diagnostic (a status reason, problems, store detail, tool reason) is replaced, never copied: paths, addresses and tokens cannot ride along', () => {
  const cp = (...codes) => String.fromCodePoint(...codes);
  const hostile = [
    'C:\\Users\\Zoë Müller\\work', '/Users/bob/project failed', 'file:///Users/bob/x', 'bob@example.invalid', `sk-ant-${cp(0x200b)}abcdefghijkl`,
    '~alice/.ssh/id_rsa', '\\\\server\\share\\x', 'has space', 'UPPER', '', 'x'.repeat(65), 'line\nbreak', 42, null, undefined
  ];
  const report = diagnose({
    vscodeVersion: '1.95.0',
    storageStatus: { state: 'unavailable', reason: hostile[0], problems: hostile },
    storeStatus: { ok: false, reason: hostile[1], detail: hostile[2] },
    managedTools: { gh: { state: 'missing', reason: hostile[3] }, codex: { state: 'missing', reason: hostile[4] }, claude: { state: 'unsupported', reason: hostile[5] } }
  });
  const text = formatDiagnosticReport(report);
  for (const leak of ['Zoë', 'Müller', 'bob', 'alice', 'example.invalid', 'sk-ant', 'server', 'has space', 'UPPER', 'line\nbreak']) {
    assert.equal(text.includes(leak), false, `the report repeats ${JSON.stringify(leak)}`);
  }
  assert.ok(report.storage.problems.every((problem) => /^[a-z0-9][a-z0-9:_.-]{0,63}$/.test(problem)), 'every problem is a plain code');
  assert.equal(report.storage.problems.length, hostile.length);
});

test('real status codes still pass through untouched, so the report stays useful', () => {
  const report = diagnose({
    vscodeVersion: '1.95.0',
    storageStatus: { state: 'unavailable', reason: 'private-directory-rejected', problems: ['repo-root-unresolvable', 'private-store-locked'] },
    storeStatus: { ok: false, reason: 'lock-failed', detail: 'owner-alive' },
    managedTools: { gh: { state: 'missing', reason: 'download-or-install-failed' } }
  });
  assert.equal(report.storage.reason, 'private-directory-rejected');
  assert.deepEqual(report.storage.problems, ['repo-root-unresolvable', 'private-store-locked']);
  assert.deepEqual([report.storage.store.reason, report.storage.store.detail], ['lock-failed', 'owner-alive']);
  assert.match(formatDiagnosticReport(report), /download-or-install-failed/);
});
