import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { agyRelease } = require('../../src/setup/tool-manifest') as {
  agyRelease(platform?: string, arch?: string): unknown;
};
const {
  classifyManagedTool,
  diagnose,
  formatDiagnosticReport
} = require('../../src/setup/diagnostics') as {
  classifyManagedTool(status: unknown): { state: string; category: string; reason: string | null };
  diagnose(options?: any): any;
  formatDiagnosticReport(report: any): string;
};

test('agyRelease returns null across all platforms because no official fixed binary assets exist (Refs #73, #94)', () => {
  const platforms = ['darwin', 'win32', 'linux', 'freebsd'];
  const archs = ['x64', 'arm64', 'arm', 'ia32'];

  for (const platform of platforms) {
    for (const arch of archs) {
      assert.equal(
        agyRelease(platform, arch),
        null,
        `agyRelease must return null for ${platform}-${arch} to prevent unverified downloads`
      );
    }
  }
  assert.equal(agyRelease(), null);
});

test('diagnose accurately classifies managed agy as unsupported and provides honest manual install guidance', () => {
  const report = diagnose({
    vscodeVersion: '1.95.0',
    nodeVersion: '20.11.0',
    executables: { git: true, gh: true, claude: false, codex: false, agy: false },
    managedTools: {
      gh: { state: 'ready', version: '2.102.0' },
      codex: { state: 'ready', version: '0.163.0' }
    }
  });

  assert.equal(report.tools.managedAgy.state, 'unsupported');
  assert.equal(report.tools.managedAgy.category, 'platform-unsupported');
  assert.equal(report.tools.managedAgy.reason, 'unverified-source-and-terms');

  const agyProvider = report.providers.find((p: any) => p.id === 'agy');
  assert.ok(agyProvider);
  assert.equal(agyProvider.executableOnPath, false);
  assert.equal(agyProvider.managedReady, false);
  assert.equal(agyProvider.cliAvailable, false);

  const agyMissingAction = report.actions.find((a: any) => a.code === 'provider-cli-missing:agy');
  assert.ok(agyMissingAction);
  assert.match(agyMissingAction.summary, /Provider CLI 'agy' is not installed on PATH/);
  assert.match(agyMissingAction.nextAction, /Install official 'agy' CLI on PATH manually/);
  assert.match(agyMissingAction.nextAction, /managed auto-deployment is unverified and unsupported/);

  const formatted = formatDiagnosticReport(report);
  assert.match(formatted, /- agy \(managed\): unsupported \(platform-unsupported:unverified-source-and-terms\)/);
});

test('when agy is present on PATH, cliAvailable is true but managedReady remains false (never implies managed verification)', () => {
  const report = diagnose({
    vscodeVersion: '1.95.0',
    nodeVersion: '20.11.0',
    executables: { git: true, gh: true, claude: false, codex: false, agy: true },
    managedTools: {
      gh: { state: 'ready', version: '2.102.0' },
      codex: { state: 'ready', version: '0.163.0' }
    }
  });

  const agyProvider = report.providers.find((p: any) => p.id === 'agy');
  assert.ok(agyProvider);
  assert.equal(agyProvider.executableOnPath, true);
  assert.equal(agyProvider.managedReady, false);
  assert.equal(agyProvider.cliAvailable, true);

  const agyMissingAction = report.actions.find((a: any) => a.code === 'provider-cli-missing:agy');
  assert.equal(agyMissingAction, undefined, 'no missing CLI warning when agy is found on system PATH');
});
