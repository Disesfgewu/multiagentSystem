import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Starts a real VS Code Extension Host with the built extension, an isolated
// profile and a temporary Git workspace. This is a startup smoke test; it does not
// replace the interactive terminal acceptance tracked by the terminal Issue, nor
// the manual multi-worktree acceptance on real macOS and Windows machines.
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

  // Short names keep the profile path under the IPC socket length limit on macOS.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-'));
  const workspace = path.join(sandbox, 'project with space');
  fs.mkdirSync(workspace);

  // The workspace is a real Git repository (synthetic content, no hooks, no signing) so the
  // worktree commands run against real Git inside the Extension Host.
  const emptyTemplate = path.join(sandbox, 'empty-template');
  fs.mkdirSync(emptyTemplate);
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.test', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${emptyTemplate}`, ...args], { cwd: workspace, stdio: 'ignore' });
  };
  git('init', '-b', 'main', `--template=${emptyTemplate}`);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'initial\n');
  git('add', 'file.txt');
  git('commit', '-m', 'initial');
  const worktreeTarget = path.join(sandbox, 'worktrees 空白', 'feature-host');

  try {
    await runTests({
      version: process.env.VSCODE_VERSION || '1.95.0',
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { MULTIAGENT_TEST_WORKSPACE: workspace, MULTIAGENT_TEST_WORKTREE: worktreeTarget },
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
