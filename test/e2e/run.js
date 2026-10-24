'use strict';

/**
 * `npm run test:e2e` (#361): the real VS Code, driven the way the owner uses it — mouse and keyboard on what is on screen, never an
 * internal command — with the built extension, a temporary profile and a temporary Git workspace. The CLIs are synthetic
 * (`fakes.js`), nothing reaches a real account or the network, and HOME points at a temporary folder so nothing of the person's
 * own `~/.claude` or `~/.codex` is read or written. Every step takes a screenshot (`artifacts/e2e/<item>-<step>.png`) and checks
 * text on the screen; `artifacts/e2e/REPORT.md` lists each item with its result, what was checked and its screenshots.
 *
 * The items are those of #360 (`steps.js`). What this proves is the screen and the flow; real accounts, a real CLI and native
 * Windows stay manual (#135).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { writeFakeClis } = require('./fakes');
const { ITEMS } = require('./steps');
const { Recorder } = require('./report');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'artifacts', 'e2e');
// `npm run test:e2e -- --update-guide`: a run where every item passed also copies its screenshots into the user guide, so the
// pictures in docs/USER_GUIDE.md always come from this run and are never kept up to date by hand.
const GUIDE_IMAGES = path.join(ROOT, 'docs', 'user-guide', 'images');
const UPDATE_GUIDE = process.argv.includes('--update-guide');
const VSCODE_VERSION = process.env.MULTIAGENT_E2E_VSCODE ?? '1.95.0';

function sandbox() {
  // Short names keep the profile path under the IPC socket length limit on macOS.
  // Under /tmp where there is one (not the per-user temporary folder, whose path is particular to this computer): the paths a
  // screenshot shows are then neutral.
  const base = process.platform !== 'win32' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'mas-e2e-')));
  const workspace = path.join(root, 'project');
  const home = path.join(root, 'home');
  const userData = path.join(root, 'ud');
  const extensions = path.join(root, 'ext');
  for (const dir of [workspace, home, path.join(userData, 'User'), extensions]) fs.mkdirSync(dir, { recursive: true });
  const template = path.join(root, 'empty-template');
  fs.mkdirSync(template);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Synthetic Owner', '-c', 'user.email=owner-a@example.test', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${template}`, ...args], { cwd: workspace, stdio: 'ignore' });
  git('init', '-b', 'main', `--template=${template}`);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Synthetic project\n\nUsed only by the end-to-end run.\n');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
  const bin = path.join(root, 'bin');
  const fakes = writeFakeClis(bin);
  const PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'window.restoreWindows': 'none',
    'window.newWindowDimensions': 'default',
    // VS Code's own dialogs instead of the system's: a native modal is not part of the page, so it could not be clicked or seen.
    'window.dialogStyle': 'custom',
    // The terminal drawn as text, not on a canvas, so a step can read what it shows.
    'terminal.integrated.gpuAcceleration': 'off',
    // VS Code's own network use goes through a proxy on a closed local port (updates, experiments and the marketplace are also off).
    // The extension's first-use download of the GitHub CLI is left out by MULTIAGENT_E2E_NO_DOWNLOAD (development mode only).
    'http.proxy': 'http://127.0.0.1:9',
    'http.proxySupport': 'override',
    'workbench.enableExperiments': false,
    'chat.commandCenter.enabled': false,
    // The agents' terminals run a plain /bin/sh with a neutral prompt, so a screenshot never shows the user or the computer's name.
    'terminal.integrated.profiles.osx': { 'E2E shell': { path: '/bin/sh', args: [] } },
    'terminal.integrated.defaultProfile.osx': 'E2E shell',
    'terminal.integrated.profiles.linux': { 'E2E shell': { path: '/bin/sh', args: [] } },
    'terminal.integrated.defaultProfile.linux': 'E2E shell',
    'terminal.integrated.env.osx': { PATH, PS1: '$ ', ENV: '' },
    'terminal.integrated.env.linux': { PATH, PS1: '$ ', ENV: '' }
  }, null, 2));
  return { root, workspace, home, userData, extensions, bin, fakes, PATH };
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const box = sandbox();
  const executablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  const app = await electron.launch({
    executablePath,
    args: [
      box.workspace,
      `--extensionDevelopmentPath=${ROOT}`,
      `--user-data-dir=${box.userData}`,
      `--extensions-dir=${box.extensions}`,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--no-cached-data'
    ],
    env: { ...process.env, HOME: box.home, USERPROFILE: box.home, PATH: box.PATH, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', ELECTRON_RUN_AS_NODE: '', MULTIAGENT_E2E_NO_DOWNLOAD: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' },
    timeout: 120000
  });
  const recorder = new Recorder(OUT);
  let failed = false;
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
    // The extension activates on startup; give its views a moment to register.
    await page.waitForSelector('.activitybar [aria-label^="Multiagent"]', { timeout: 60000 });
    for (const item of ITEMS) {
      const ok = await recorder.item(item, page, box);
      if (!ok) failed = true;
    }
  } catch (error) {
    failed = true;
    recorder.fatal(error);
  } finally {
    recorder.write({ vscode: VSCODE_VERSION });
    await app.close().catch(() => {});
    fs.rmSync(box.root, { recursive: true, force: true });
  }
  console.log(`e2e: ${recorder.summary()} — see ${path.relative(ROOT, path.join(OUT, 'REPORT.md'))}`);
  if (UPDATE_GUIDE) {
    if (failed) console.log('e2e: the user guide pictures were not updated (not every item passed)');
    else {
      fs.mkdirSync(GUIDE_IMAGES, { recursive: true });
      const shots = recorder.screenshots();
      for (const file of shots) fs.copyFileSync(path.join(OUT, file), path.join(GUIDE_IMAGES, file));
      console.log(`e2e: copied ${shots.length} screenshots into ${path.relative(ROOT, GUIDE_IMAGES)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
