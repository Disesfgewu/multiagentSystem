import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Guards the private-data boundary of the extension's GitHub read path: it must not reach for
// the machine (files, processes, environment, CLI logins), must only read, and may obtain a
// credential only from the editor's own authentication provider.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'github');
const files = fs.readdirSync(SRC).filter((name) => name.endsWith('.ts'));
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (name: string): string => strip(fs.readFileSync(path.join(SRC, name), 'utf8'));
const count = (code: string, pattern: RegExp): number => [...code.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;

test('the GitHub sources are present', () => {
  assert.deepEqual(files.sort(), ['controller.ts', 'githubCommands.ts']);
});

test('the command logic does not import the editor, so it can be tested without one', () => {
  assert.doesNotMatch(read('controller.ts'), /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/);
});

test('the sources import no file, process, network or OS module', () => {
  const allowedTargets = new Set(['vscode', '../../packages/github-read-adapter/src', '../projects/worktrees', './controller']);
  for (const name of files) {
    for (const match of read(name).matchAll(/(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(allowedTargets.has(match[1]), `${name} imports ${match[1]}`);
    }
    assert.doesNotMatch(read(name), /node:(?:fs|os|child_process|net|http|https|tls|dns|worker_threads)/, name);
  }
});

test('nothing reaches for the environment, CLI logins, stored credentials or logs', () => {
  const forbidden = [
    /process\.env/, /process\.argv/, /\bchild_process\b/, /\bos\.homedir\b/,
    /\.netrc|\.git-credentials|credentials\.json|auth\.json/, /\bgh\s+auth\b/, /\.claude\b|\.codex\b|CLAUDE_CONFIG_DIR|CODEX_HOME/,
    /\bconsole\./, /\boutputChannel\b|createOutputChannel/,
    /globalState|workspaceState|\.secrets\b|SecretStorage|globalStorageUri|storageUri/,
    /workspace\.fs|writeFile|appendFile|\bmkdir\b|\bunlink\b/,
    /\blocalStorage\b|sessionStorage/, /\beval\s*\(|new Function\s*\(/
  ];
  for (const name of files) {
    for (const pattern of forbidden) assert.doesNotMatch(read(name), pattern, `${name} matches ${pattern}`);
  }
});

test('no write request exists in the sources: no write verbs and no direct network call', () => {
  for (const name of files) {
    const code = read(name);
    assert.doesNotMatch(code, /['"](?:POST|PUT|PATCH|DELETE)['"]/, name);
    assert.doesNotMatch(code, /method\s*:/, `${name} builds no request of its own`);
    assert.doesNotMatch(code, /\bXMLHttpRequest\b|\bWebSocket\b|\bhttp\.request\b|\bhttps\.request\b/, name);
  }
  // The only reference to the global fetch is the one handed to the read-only adapter's transport.
  const offenders = files.filter((name) => /\bfetch\s*\(/.test(read(name)));
  assert.deepEqual(offenders, []);
  assert.equal(count(read('githubCommands.ts'), /globalThis\.fetch/), 1);
});

test('a credential comes only from the editor\'s authentication provider, silently, and only to the adapter', () => {
  const commands = read('githubCommands.ts');
  assert.equal(count(commands, /authentication\.getSession\(/), 2, 'one silent read and one explicit sign-in');
  assert.equal(count(commands, /silent:\s*true/), 1);
  assert.equal(count(commands, /createIfNone:\s*true/), 1);
  assert.doesNotMatch(commands, /forceNewSession|clearSessionPreference|authentication\.registerAuthenticationProvider|authentication\.onDidChangeSessions/);
  assert.equal(count(commands, /\.accessToken/), 1, 'the token is read in exactly one place');
  const token = /const session = await vscode\.authentication\.getSession\(GITHUB_AUTH_PROVIDER, \[\.\.\.GITHUB_SCOPES\], \{ silent: true \}\);\s*return session\?\.accessToken;/;
  assert.match(commands, token, 'and returned straight to the adapter, not kept or passed on');
  assert.equal(count(commands, /getToken:\s*overrides\.getToken \?\? sessionToken/), 1, 'handed to the adapter, either the editor\'s provider or the test override');
  assert.equal(count(read('controller.ts'), /accessToken|getSession|authentication/), 0, 'the controller never sees a credential');
});

test('the browser is only opened through the controller, which checks the address first', () => {
  assert.equal(count(read('githubCommands.ts'), /env\.openExternal/), 1);
  const controller = read('controller.ts');
  assert.equal(count(controller, /openExternal\(/), 2, 'its declaration and its single call');
  assert.match(controller, /if \(!isGitHubWebUrl\(url\)\) return failure\('unsafe-url'/);
});

test('test overrides cannot be installed outside test mode, and no command argument can select a transport or credential', () => {
  const commands = read('githubCommands.ts');
  assert.match(commands, /testMode = context\.extensionMode === vscode\.ExtensionMode\.Test/);
  assert.match(commands, /if \(!testMode\) throw new Error\(/);
  const parse = commands.slice(commands.indexOf('function commandOptions'), commands.indexOf('export function registerGitHubCommands'));
  assert.doesNotMatch(parse, /fetch|transport|token|getToken|openExternal|adapter/i, 'a command argument is limited to plain options');
  for (const key of ['interactive', 'repository', 'kind', 'number', 'open']) assert.match(parse, new RegExp(`input\\.${key}`));
});

test('the commands in package.json match the ones the code registers, and each activates the extension', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    activationEvents: string[];
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  const registered = [...read('githubCommands.ts').matchAll(/'(multiagentSystem\.github\.[A-Za-z]+)'/g)].map((match) => match[1]).sort();
  assert.equal(registered.length, 6);
  const declared = manifest.contributes.commands.map((entry) => entry.command).filter((id) => id.startsWith('multiagentSystem.github.')).sort();
  assert.deepEqual(declared, registered);
  for (const id of registered) {
    assert.ok(manifest.activationEvents.includes(`onCommand:${id}`), `${id} activates the extension`);
    assert.match(manifest.contributes.commands.find((entry) => entry.command === id)?.title ?? '', /^Multiagent: /);
  }
  assert.equal(count(fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8'), /registerGitHubCommands\(context\)/), 1);
});

test('the manifest does not declare Workspace Trust support, so Restricted Mode keeps the extension off', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('capabilities' in manifest, false);
});

test('the sources and tests contain no invisible or direction-changing characters that could hide what the code does', () => {
  const invisible = (code: number): boolean => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x200b && code <= 0x200f) || code === 0x2060 || code === 0xfeff || code === 0x061c || code === 0xad ||
    code === 0x2028 || code === 0x2029 || (code >= 0x80 && code <= 0x9f) || code === 0x7f;
  const targets = [
    ...files.map((name) => path.join(SRC, name)),
    path.join(ROOT, 'test', 'unit', 'githubController.test.ts'),
    path.join(ROOT, 'test', 'unit', 'githubBoundary.test.ts'),
    path.join(ROOT, 'test', 'host', 'suite', 'github.ts')
  ];
  for (const target of targets) {
    const found = [...fs.readFileSync(target, 'utf8')].filter((char) => invisible(char.codePointAt(0) ?? 0));
    assert.deepEqual(found, [], `${path.basename(target)} contains an invisible character`);
  }
});
