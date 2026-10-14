import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Starts a real VS Code Extension Host with the built extension, an isolated
// profile and a temporary workspace. This is a startup smoke test; it does not
// replace the interactive terminal acceptance tracked by the terminal Issue.
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

  // Short names keep the profile path under the IPC socket length limit on macOS.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-'));
  const workspace = path.join(sandbox, 'project with space');
  fs.mkdirSync(workspace);

  try {
    await runTests({
      version: process.env.VSCODE_VERSION || '1.95.0',
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { MULTIAGENT_TEST_WORKSPACE: workspace },
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${path.join(sandbox, 'ud')}`,
        `--extensions-dir=${path.join(sandbox, 'ext')}`
      ]
    });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
