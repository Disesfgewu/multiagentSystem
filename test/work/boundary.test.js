'use strict';

// Guards what this module is: pure decisions over injected reader, writer and store. It must
// not reach the machine or the network, must only ever ask the writer for the two operations
// that change a status label, and must have no operation that could define or change an
// issue's requirements.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'work');
const files = fs.readdirSync(SRC).filter((name) => name.endsWith('.js'));
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (name) => strip(fs.readFileSync(path.join(SRC, name), 'utf8'));
const all = () => files.map(read).join('\n');

test('the sources are present', () => {
  assert.deepEqual(files.sort(), ['coordinator.js', 'index.js', 'labels.js', 'links.js', 'states.js']);
});

test('only sibling modules are required: no file, process, network, OS or editor module, and no package', () => {
  for (const name of files) {
    for (const match of read(name).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      assert.ok(match[1].startsWith('./'), `${name} requires ${match[1]}`);
    }
  }
});

test('nothing reaches for the environment, the disk, the network or a CLI login', () => {
  const forbidden = [
    /process\.(?:env|argv|cwd|exit)/, /\bchild_process\b/, /\bos\.|\bhomedir\b|\btmpdir\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b|\bWebSocket\b/,
    /node:(?:fs|os|net|http|https|child_process)/, /\bwriteFile|\breadFile|\bmkdir|\bunlink\b/,
    /api\.github\.com|github\.com\//, /\.claude\b|\.codex\b|CLAUDE_CONFIG_DIR|CODEX_HOME|\bgh\s+auth\b|credentials\.json|auth\.json/,
    /\bconsole\./, /\bvscode\b/
  ];
  for (const name of files) for (const pattern of forbidden) assert.doesNotMatch(read(name), pattern, `${name} matches ${pattern}`);
});

test('the writer is only ever asked to claim an issue or to set its status label, and the reader to read one issue', () => {
  const code = all();
  const writerCalls = [...new Set([...code.matchAll(/writer\.(\w+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(writerCalls, ['claim', 'setLabel']);
  const readerCalls = [...new Set([...code.matchAll(/reader\.(\w+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(readerCalls, ['getIssue']);
  assert.doesNotMatch(code, /createIssue|editIssue|updateIssue|updateBody|setBody|setTitle|mergePullRequest|createPullRequest|submitReview|addComment|postComment/i);
});

test('what is handed to the writer is built in one place, from the repository, the number, a label and a version only', () => {
  const code = read('coordinator.js');
  assert.equal([...code.matchAll(/const writePayload = /g)].length, 1, 'defined once');
  assert.equal([...code.matchAll(/writePayload\(/g)].length, 2, 'used for the claim and for a label change, and nowhere else');
  const body = code.slice(code.indexOf('const writePayload'), code.indexOf('function checkClaimInput'));
  assert.match(body, /repo: \{ owner: repo\.owner, name: repo\.name \}, issueNumber, label, expectedUpdatedAt/);
  assert.doesNotMatch(body, /session|worktree|branch|link/i);
  for (const call of code.matchAll(/writer\.(?:claim|setLabel)\(([^;]*)\)\)?;/g)) assert.match(call[1], /^writePayload\(/, 'every write uses it');
});

test('the sources contain no invisible or direction-changing characters', () => {
  const invisible = (code) => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || (code >= 0x200b && code <= 0x200f) ||
    code === 0x2060 || code === 0xfeff || code === 0x061c || code === 0xad || code === 0x2028 || code === 0x2029 || (code >= 0x80 && code <= 0x9f);
  const targets = [...files.map((name) => path.join(SRC, name)), ...fs.readdirSync(__dirname).filter((name) => name.endsWith('.js')).map((name) => path.join(__dirname, name))];
  for (const target of targets) {
    const found = [...fs.readFileSync(target, 'utf8')].filter((char) => invisible(char.codePointAt(0)));
    assert.deepEqual(found, [], `${path.basename(target)} contains an invisible character`);
  }
});
