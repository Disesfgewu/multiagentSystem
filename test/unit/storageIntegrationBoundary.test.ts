import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Guards the private-data boundary of the extension's storage integration: private data goes
// only to the editor's own storage folder, never to a fallback place, and nothing here reads a
// CLI login or the environment.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILES = ['extensionStorage.ts', 'storageCommands.ts'];
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (name: string): string => strip(fs.readFileSync(path.join(ROOT, 'src', 'storage', name), 'utf8'));
const count = (code: string, pattern: RegExp): number => [...code.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
const imports = (code: string): string[] => [...code.matchAll(/(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]).sort();

test('the pure module imports only the path helper and the existing storage modules, never the editor', () => {
  assert.deepEqual(imports(read('extensionStorage.ts')), ['./paths', './private-store', './secrets', 'node:path']);
});

test('the editor binding imports only the editor, the worktree service and the pure module', () => {
  assert.deepEqual(imports(read('storageCommands.ts')), ['../projects/worktrees', './extensionStorage', 'vscode']);
});

test('nothing reaches for the environment, CLI logins, the home or temporary folder, or the working directory', () => {
  const forbidden = [
    /process\.env/, /process\.argv/, /process\.cwd/, /__dirname|__filename/, /\bchild_process\b/,
    /\btmpdir\b|\bhomedir\b|\bos\./, /node:(?:fs|os|child_process|net|http|https)/,
    /\.claude\b|\.codex\b|CLAUDE_CONFIG_DIR|CODEX_HOME|auth\.json|credentials\.json|\.netrc|\bgh\s+auth\b/,
    /\bconsole\./, /\bcreateOutputChannel\b/,
    /globalState|workspaceState|workspace\.fs|\bwriteFile|\bmkdir|\bappendFile|\bunlink\b|\brmSync\b/
  ];
  for (const name of FILES) {
    for (const pattern of forbidden) assert.doesNotMatch(read(name), pattern, `${name} matches ${pattern}`);
  }
});

test('the data folder is computed in exactly one place, inside the editor\'s storage folder, with no alternative', () => {
  const code = read('extensionStorage.ts');
  assert.equal(count(code, /nodePath\.join\(bound\.storageDir, PRIVATE_FOLDER\)/), 1);
  assert.equal(count(code, /nodePath\./), 1, 'no other path is built');
  assert.equal(count(code, /\bdir\s*=/), 1, 'the folder is assigned once');
  assert.doesNotMatch(read('storageCommands.ts'), /nodePath|path\.join|path\.resolve/);
  // The extension's own folder is only a stand-in for comparison when no folder is open.
  assert.match(code, /const standIn = deps\.context\.extensionPath;/);
  assert.equal(count(code, /standIn/), 3);
});

test('the repository check runs on every use, against every open folder', () => {
  const code = read('extensionStorage.ts');
  assert.match(code, /const folders = deps\.workspaceFolders\(\);/);
  assert.match(code, /for \(const root of toCheck\) \{\s*const verdict = checkPrivateRoot\(dir, root\)/);
  assert.match(code, /if \(problems\.length > 0\) return unavailable\('directory-rejected'/);
});

test('Git is asked about a repository only in a trusted workspace', () => {
  assert.match(read('storageCommands.ts'), /if \(!vscode\.workspace\.isTrusted\) return null;/);
});

test('the test context is reachable only in test mode, and a command argument can only ask for the probe and a quiet reply', () => {
  const code = read('storageCommands.ts');
  assert.match(code, /testContext = context\.extensionMode === vscode\.ExtensionMode\.Test \? context : undefined;/);
  assert.match(code, /if \(!testContext\) throw new Error\(/);
  const argument = code.slice(code.indexOf('registerCommand(STORAGE_COMMANDS.status'));
  assert.deepEqual([...new Set([...argument.matchAll(/\)\.(\w+) ===/g)].map((match) => match[1]))].sort(), ['interactive', 'probeSecrets']);
});

test('the status command is declared and activates the extension', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    activationEvents: string[];
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  assert.ok(manifest.activationEvents.includes('onCommand:multiagentSystem.storage.status'));
  assert.match(manifest.contributes.commands.find((entry) => entry.command === 'multiagentSystem.storage.status')?.title ?? '', /^Multiagent: /);
  assert.equal(count(fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8'), /registerStorageCommands\(context\)/), 1);
});

test('the sources and tests contain no invisible or direction-changing characters', () => {
  const invisible = (code: number): boolean => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x200b && code <= 0x200f) || code === 0x2060 || code === 0xfeff || code === 0x061c || code === 0xad ||
    code === 0x2028 || code === 0x2029 || (code >= 0x80 && code <= 0x9f) || code === 0x7f;
  const targets = [
    ...FILES.map((name) => path.join(ROOT, 'src', 'storage', name)),
    path.join(ROOT, 'test', 'unit', 'extensionStorage.test.ts'),
    path.join(ROOT, 'test', 'unit', 'storageIntegrationBoundary.test.ts'),
    path.join(ROOT, 'test', 'host', 'suite', 'storage.ts')
  ];
  for (const target of targets) {
    const found = [...fs.readFileSync(target, 'utf8')].filter((char) => invisible(char.codePointAt(0) ?? 0));
    assert.deepEqual(found, [], `${path.basename(target)} contains an invisible character`);
  }
});
