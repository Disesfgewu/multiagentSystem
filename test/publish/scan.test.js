'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanPublication, KINDS, LIMITS, LIMITATIONS } = require('../../src/publish/scan');

// Every secret below is synthetic. The scanner must never repeat any of them.
const TOKEN = 'ghp_syntheticsyntheticsynthetic1234';
const SESSION = '123e4567-e89b-12d3-a456-426614174000';
const HOME = '/Users/someone/private-project';
const ALL_SECRETS = [TOKEN, SESSION, HOME, 'someone', 'hunter2hunter2', 'Personal-Work-Account'];

const scan = (kind, text, options) => scanPublication([{ kind, text }], options);
const codes = (result) => result.findings.map((finding) => finding.code).sort();

function assertNoEcho(result) {
  const text = JSON.stringify(result);
  for (const secret of ALL_SECRETS) assert.equal(text.includes(secret), false, `the result repeats ${secret.slice(0, 6)}...`);
}

const newFileDiff = (file, added, { start = 1 } = {}) =>
  [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +${start},${added.length} @@`, ...added.map((line) => `+${line}`)].join('\n') + '\n';

test('every kind of publication is scanned, and a synthetic token is refused in each', () => {
  for (const kind of KINDS.filter((k) => k !== 'diff')) {
    const result = scan(kind, `harmless words ${TOKEN} more words`);
    assert.equal(result.status, 'blocked', kind);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.findings.map((f) => [f.kind, f.code, f.category, f.line, f.column]), [[kind, 'github-token', 'credential', 1, 16]], kind);
    assertNoEcho(result);
  }
  const diff = scan('diff', newFileDiff('notes.md', [`token note ${TOKEN}`]));
  assert.equal(diff.status, 'blocked');
  assertNoEcho(diff);
});

test('session ids, internal paths and credentials are found together with exact positions', () => {
  const text = ['first line is fine', `session ${SESSION} was used`, `built in ${HOME}`, 'and C:\\Users\\Someone\\repo too'].join('\n');
  const result = scan('pr-body', text);
  assert.equal(result.status, 'blocked');
  const places = result.findings.map((f) => [f.code, f.line, f.column]).sort();
  assert.deepEqual(places, [['home-path', 3, 10], ['home-path', 4, 5], ['uuid', 2, 9]]);
  assert.deepEqual([...new Set(result.findings.map((f) => f.category))].sort(), ['identifier', 'local-path']);
  assertNoEcho(result);
});

test('positions count lines in CRLF text and columns from 1', () => {
  const result = scan('comment', `line one\r\nline two ${TOKEN}\r\nline three`);
  assert.deepEqual(result.findings.map((f) => [f.line, f.column]), [[2, 10]]);
});

test('findings carry only code, category, location, kind and a static hint', () => {
  const result = scan('pr-body', `${TOKEN} ${SESSION} ${HOME}`, { knownValues: [{ id: 'k1', value: 'someone' }] });
  const allowed = new Set(['unit', 'kind', 'code', 'category', 'line', 'column', 'fileIndex', 'id', 'hint', 'degraded']);
  for (const finding of result.findings) {
    for (const key of Object.keys(finding)) assert.ok(allowed.has(key), key);
    assert.equal(typeof finding.hint, 'string');
  }
  assertNoEcho(result);
});

test('values the caller registered as private are found by id; short ones are listed, not skipped', () => {
  const options = { knownValues: [{ id: 'account-label', value: 'Personal-Work-Account' }, { id: 'tiny', value: 'ab' }] };
  const result = scan('issue-body', 'Hello from the personal-work-account profile.', options);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings.map((f) => [f.code, f.category, f.id, f.line, f.column]), [['known-value', 'known-value', 'account-label', 1, 16]]);
  assert.deepEqual(result.unmatchable, ['tiny']);
  assertNoEcho(result);
  assert.equal(scan('issue-body', 'A public sentence.', options).status, 'clear');
  assert.deepEqual(scan('issue-body', 'A public sentence.', options).unmatchable, ['tiny']);
});

test('private memory and rule text is found by id, also when lightly reformatted', () => {
  const memories = [{ id: 'mem_1', content: 'The release gate for this repo is the Orion checklist, step nine requires two reviewers.' }];
  const rules = [{ id: 'r_1', text: 'Never mention the Orion checklist numbering outside the team.' }];
  const body = 'Summary\n\nthe RELEASE gate for this repo is the Orion checklist -- step nine requires two reviewers!\n\nNever mention the orion checklist numbering outside the team';
  const result = scan('pr-body', body, { memories, rules });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings.map((f) => [f.code, f.id, f.line]).sort(), [['memory-fragment', 'mem_1', 3], ['rule-fragment', 'r_1', 5]]);
  assert.equal(JSON.stringify(result).includes('Orion'), false);
  assert.equal(scan('pr-body', 'This change adds validation for configuration directories.', { memories, rules }).status, 'clear');
});

test('private items too short to match are reported on the result', () => {
  const result = scan('comment', 'abc OK!', { memories: [{ id: 'mem_t', content: 'abc' }], rules: [{ id: 'r_t', text: 'OK!' }] });
  assert.equal(result.status, 'clear');
  assert.deepEqual(result.unmatchable.sort(), ['mem_t', 'r_t']);
});

test('a diff reports added lines with their line number in the new file and ignores removed and context lines', () => {
  const diff = [
    'diff --git a/src/x.md b/src/x.md',
    '--- a/src/x.md',
    '+++ b/src/x.md',
    '@@ -20,5 +20,6 @@',
    ` already public context ${TOKEN}`,
    `-removed ${TOKEN}`,
    '+clean added line',
    `+oops ${SESSION}`,
    ' more context',
    ' more context',
    ' more context'
  ].join('\n') + '\n';
  const result = scan('diff', diff);
  assert.deepEqual(result.findings.map((f) => [f.kind, f.fileIndex, f.code, f.line, f.column]), [['diff', 0, 'uuid', 22, 6]]);
  assertNoEcho(result);
});

test('a new sensitive file name is refused, an example file is not; paths with private names are caught', () => {
  const env = scan('diff', newFileDiff('.env', ['MODE=development']));
  assert.deepEqual(env.findings.map((f) => [f.kind, f.code, f.category]), [['file-path', 'sensitive-file-name', 'file-name']]);
  assert.equal(scan('diff', newFileDiff('.env.example', ['MODE=development'])).status, 'clear');
  assert.equal(scan('diff', newFileDiff('docs/auth.md', ['About authentication.'])).status, 'clear');

  const pathLeak = scan('diff', newFileDiff('docs/Users/x/notes.md', ['ok']).replace('docs/Users/x/notes.md', `${HOME}/notes.md`));
  assert.ok(codes(pathLeak).includes('home-path'));
  assert.equal(pathLeak.findings[0].kind, 'file-path');
  assertNoEcho(pathLeak);

  const renamed = [`diff --git a/old.md b/${'.env'}`, 'similarity index 100%', 'rename from old.md', 'rename to .env'].join('\n') + '\n';
  assert.deepEqual(codes(scan('diff', renamed)), ['sensitive-file-name']);
});

test('a modified existing file with a sensitive name is not flagged by name (it is already in the repository)', () => {
  const modified = ['diff --git a/.env b/.env', '--- a/.env', '+++ b/.env', '@@ -1,1 +1,1 @@', '-A=1', '+A=2'].join('\n') + '\n';
  assert.equal(scan('diff', modified).status, 'clear');
});

test('binary files cannot be scanned: the result is incomplete and blocked, never clear', () => {
  const diff = ['diff --git a/logo.png b/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/logo.png differ'].join('\n') + '\n';
  const result = scan('diff', diff);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.blocked, true);
  assert.deepEqual(result.unscanned.map((u) => [u.unit, u.fileIndex, u.reason]), [[0, 0, 'binary-content']]);
  assert.deepEqual(result.findings, []);
});

test('a diff that cannot be read is scanned as a whole text, including removed lines', () => {
  const result = scan('diff', `not really a diff\n-removed ${TOKEN}\nmore`);
  assert.equal(result.status, 'blocked');
  assert.equal(result.findings[0].degraded, 'unparsed-diff');
  assert.equal(result.findings[0].line, 2);
});

test('in source code, an assignment from code is not a credential, but a quoted literal is', () => {
  const code = newFileDiff('src/lock.js', ['const token = crypto.randomBytes(8).toString("hex");', 'token = this.#lock();', 'const REF = /^secret:[A-Za-z0-9]+$/;', 'password = "hunter2hunter2";']);
  const result = scan('diff', code);
  assert.deepEqual(result.findings.map((f) => [f.code, f.line]), [['credential-assignment', 4]]);
  assertNoEcho(result);
  // Other file types keep the strict shape.
  assert.equal(scan('diff', newFileDiff('run.sh', ['PASSWORD=hunter2hunter2'])).status, 'blocked');
  assert.equal(scan('diff', newFileDiff('config.yml', ['password: hunter2hunter2'])).status, 'blocked');
  assert.equal(scan('pr-body', 'token = crypto.randomBytes(8)').status, 'blocked', 'plain text keeps the strict shape');
  // The refinement does not touch any other shape, even in code.
  assert.equal(scan('diff', newFileDiff('src/a.ts', [`const x = "${TOKEN}";`])).status, 'blocked');
});

test('ordinary public content passes: README, a plan document and source code of this repository', () => {
  const root = path.join(__dirname, '..', '..');
  for (const file of ['README.md', 'docs/IMPLEMENTATION_PLAN.md', 'src/agents.ts']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const asBody = scan('pr-body', text);
    assert.equal(asBody.status, 'clear', `${file} as text: ${JSON.stringify(asBody.findings.map((f) => [f.code, f.line]))}`);
    const asDiff = scan('diff', newFileDiff(file, text.split('\n')));
    assert.equal(asDiff.status, 'clear', `${file} as diff`);
  }
  assert.equal(scan('commit-message', 'feat: add validation for configuration directories\n\nRefs #12').status, 'clear');
  assert.equal(scan('branch-name', 'feat/issue-12-account-profile-service').status, 'clear');
  assert.equal(scan('pr-title', 'P1: AccountProfile 服務與帳號顯示資料（Refs #12）').status, 'clear');
});

test('a branch name that carries a session id is refused', () => {
  const result = scan('branch-name', `agent/${SESSION}`);
  assert.deepEqual(result.findings.map((f) => [f.kind, f.code]), [['branch-name', 'uuid']]);
});

test('several units are scanned and located by their index', () => {
  const result = scanPublication([
    { kind: 'pr-title', text: 'A public title' },
    { kind: 'pr-body', text: `body ${TOKEN}` },
    { kind: 'comment', text: `comment ${SESSION}` }
  ]);
  assert.deepEqual(result.findings.map((f) => [f.unit, f.kind, f.code]), [[1, 'pr-body', 'github-token'], [2, 'comment', 'uuid']]);
  assert.equal(result.scanned, 3);
});

test('a clean scan says so, and always carries the limitations', () => {
  const result = scan('pr-body', 'A change that renames a function and updates its tests.');
  assert.equal(result.status, 'clear');
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.limitations, [...LIMITATIONS]);
  assert.ok(result.limitations.includes('paraphrase-not-detected'));
  assert.ok(result.limitations.includes('human-review-still-required'));
});

test('fails closed: unusable input, oversize input and unknown kinds block', () => {
  for (const bad of [undefined, null, 'text', {}, [], [null], [{ kind: 'pr-body' }], [{ kind: 'pr-body', text: 5 }], [{ kind: 'unknown', text: 'x' }], [{ text: 'x' }]]) {
    const result = scanPublication(bad);
    assert.equal(result.status, 'error', JSON.stringify(bad));
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'invalid-input');
  }
  const big = scan('pr-body', 'x'.repeat(LIMITS.maxUnitChars + 1));
  assert.deepEqual([big.status, big.blocked, big.reason], ['error', true, 'input-too-large']);
  const many = scanPublication(Array.from({ length: LIMITS.maxUnits + 1 }, () => ({ kind: 'comment', text: 'x' })));
  assert.equal(many.reason, 'input-too-large');
  const total = scanPublication(Array.from({ length: 5 }, () => ({ kind: 'comment', text: 'x'.repeat(1_800_000) })));
  assert.equal(total.reason, 'input-too-large');
  assert.equal(scan('pr-body', '').status, 'clear', 'an empty body is fine');
});

test('fails closed: a throwing detector or an invalid private list blocks without repeating the text', () => {
  const thrower = { name: 'broken', detect: () => { throw new Error(`failed on ${TOKEN}`); } };
  const result = scan('pr-body', `text ${TOKEN}`, { detectors: [thrower] });
  assert.deepEqual([result.status, result.blocked, result.reason], ['error', true, 'scanner-failed']);
  assertNoEcho(result);
  assert.equal(scan('pr-body', 'x', { knownValues: [{ id: 5, value: 'y' }] }).reason, 'scanner-failed');
  assert.equal(scan('pr-body', 'x', { memories: [{ id: 'm', content: 5 }] }).status, 'error');
});

test('detectors are replaceable: a custom detector replaces the defaults', () => {
  const custom = { name: 'custom', detect: (text) => (text.includes('forbidden') ? [{ code: 'custom-rule', category: 'known-value', index: text.indexOf('forbidden') }] : []) };
  assert.deepEqual(scan('pr-body', `fine ${TOKEN}`, { detectors: [custom] }).status, 'clear', 'the default shapes are not applied');
  const hit = scan('pr-body', 'a\nthis is forbidden', { detectors: [custom] });
  assert.deepEqual(hit.findings.map((f) => [f.code, f.line, f.column]), [['custom-rule', 2, 9]]);
});

test('findings are capped and the result says so, still blocked', () => {
  const result = scan('pr-body', `${TOKEN}\n`.repeat(300), { detectors: [{ name: 'many', detect: (text) => Array.from({ length: 300 }, (_, i) => ({ code: 'github-token', category: 'credential', index: i * (TOKEN.length + 1) })) }] });
  assert.equal(result.findings.length, LIMITS.maxFindings);
  assert.equal(result.truncated, true);
  assert.equal(result.blocked, true);
});

test('a home path is reported once even though two detectors know it', () => {
  const result = scan('pr-body', `see ${HOME}/file`);
  assert.deepEqual(result.findings.map((f) => f.category), ['local-path']);
});

test('binary content is never reported clear, whether or not the diff could be read', () => {
  const unreadable = scan('diff', 'Binary files a/x.bin and b/x.bin differ\n');
  assert.equal(unreadable.status, 'incomplete');
  assert.deepEqual(unreadable.unscanned.map((u) => u.reason), ['binary-content']);
  const git = scan('diff', 'GIT binary patch\nliteral 12\nzc$@SOMEDATA\n');
  assert.equal(git.blocked, true);
  const headerless = scan('diff', ['diff --git a/logo.png b/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/logo.png differ'].join('\n'));
  assert.equal(headerless.status, 'incomplete');
  assert.equal(headerless.unscanned[0].fileIndex, 0);
  // A text file next to a binary one is still scanned.
  const mixed = scan('diff', [newFileDiff('notes.md', [`oops ${SESSION}`]), 'diff --git a/i.png b/i.png', 'new file mode 100644', 'Binary files /dev/null and b/i.png differ'].join('\n'));
  assert.deepEqual([mixed.status, mixed.findings.length, mixed.unscanned.length], ['blocked', 1, 1]);
});

test('the path of a binary or renamed file is still scanned', () => {
  const diff = ['diff --git a/x b/private/.env', 'new file mode 100644', 'Binary files /dev/null and b/private/.env differ'].join('\n') + '\n';
  const result = scan('diff', diff);
  assert.ok(codes(result).includes('sensitive-file-name'));
  assert.equal(result.unscanned.length, 1);
});

// ---- review: nothing outside a hunk may be dropped silently ---------------------------------

const TOK = 'ghp_syntheticsyntheticsynthetic1234';

test('lines the diff reader does not understand are never dropped: the whole text is scanned instead (fail closed)', () => {
  const cases = {
    'undercounted hunk header': ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,1 @@', '-a', '+b', `+${TOK}`].join('\n') + '\n',
    'noise line after a hunk': ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,1 @@', '-a', '+b', `note ${TOK}`].join('\n') + '\n',
    'preface before the first header': [`Subject: [PATCH] something ${TOK}`, '', '---', 'diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n') + '\n',
    'text between two files': ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,1 @@', '-a', '+b', `comment ${TOK}`, 'diff --git a/b.md b/b.md', '--- a/b.md', '+++ b/b.md', '@@ -1,1 +1,1 @@', '-c', '+d'].join('\n') + '\n',
    'plus line directly outside any hunk': ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', `+${TOK}`].join('\n') + '\n',
    'merge-style diff': ['diff --cc a.md', 'index 1,2..3', '--- a/a.md', '+++ b/a.md', '@@@ -1,1 -1,1 +1,2 @@@', ` +${TOK}`].join('\n') + '\n'
  };
  for (const [name, text] of Object.entries(cases)) {
    const result = scan('diff', text);
    assert.equal(result.status, 'blocked', name);
    assert.ok(result.findings.some((f) => f.code === 'github-token'), name);
    assert.ok(result.findings.every((f) => f.degraded === 'unparsed-diff'), `${name}: reported as degraded`);
    assertNoEcho(result);
  }
});

test('a correct hunk with the same content is still read normally, with exact line numbers', () => {
  const text = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,2 @@', '-a', '+b', `+${TOK}`].join('\n') + '\n';
  const result = scan('diff', text);
  assert.deepEqual(result.findings.map((f) => [f.code, f.line, f.degraded]), [['github-token', 2, undefined]]);
});

test('every git extended header is understood and does not make a diff degrade', () => {
  const text = [
    'diff --git a/old.sh b/new.sh',
    'old mode 100644',
    'new mode 100755',
    'similarity index 90%',
    'rename from old.sh',
    'rename to new.sh',
    'index 1234567..89abcde 100755',
    '--- a/old.sh',
    '+++ b/new.sh',
    '@@ -1,1 +1,1 @@',
    '-echo a',
    '+echo b',
    'diff --git a/c.txt b/copy.txt',
    'dissimilarity index 10%',
    'copy from c.txt',
    'copy to copy.txt',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '',
    'diff --git a/pic.png b/pic.png',
    'new file mode 100644',
    'index 0000000..2222222',
    'GIT binary patch',
    'literal 12',
    'zc$@SOMEBASE85PAYLOAD',
    '',
    'literal 0',
    'HcmV?d00001',
    ''
  ].join('\n');
  const result = scan('diff', text);
  assert.ok(result.findings.every((f) => f.degraded === undefined), JSON.stringify(result.findings));
  assert.equal(result.status, 'incomplete', 'only the binary patch is unscanned');
  assert.deepEqual(result.unscanned.map((u) => u.reason), ['binary-content']);
});

test('a template literal assigned to a password in code is still a literal', () => {
  const result = scan('diff', newFileDiff('src/a.js', ['const password = `hunter2hunter2`;']));
  assert.deepEqual(result.findings.map((f) => f.code), ['credential-assignment']);
  assert.equal(scan('diff', newFileDiff('src/a.js', ['const password = `${process.env.PASSWORD_VALUE}`;'])).status, 'clear', 'an interpolation alone is code, not a literal');
  assert.equal(scan('diff', newFileDiff('src/a.js', ["const password = 'hunter2hunter2';"])).status, 'blocked');
});

test('WSL and other UNC hosts with a dollar sign are local paths', () => {
  for (const text of ['\\\\wsl$\\Ubuntu\\home\\alice\\x', '\\\\wsl.localhost\\Ubuntu\\home\\alice', '\\\\server$\\share', '/mnt/c/Users/alice/x', 'C:\\Users\\alice\\x', 'C:/Users/alice/x']) {
    assert.equal(scan('pr-body', `see ${text} here`).status, 'blocked', text);
  }
});

test('when a detector hits its cap the result says it is truncated', () => {
  const many = scan('pr-body', `${TOK}\n`.repeat(40));
  assert.equal(many.status, 'blocked');
  assert.equal(many.truncated, true);
  assert.equal(scan('pr-body', `${TOK}\n`.repeat(3)).truncated, false);
});

test('a copied file with a sensitive name is refused like a new one', () => {
  const diff = ['diff --git a/c.txt b/.env', 'similarity index 100%', 'copy from c.txt', 'copy to .env'].join('\n') + '\n';
  assert.deepEqual(codes(scan('diff', diff)), ['sensitive-file-name']);
});

test('a doubled-backslash Windows path is blocked in every unit kind and never echoed', () => {
  const text = 'leak C:\\\\Users\\\\someone\\\\secret.txt and \\\\\\\\server\\\\share and ~/.ssh/id_rsa';
  for (const kind of ['pr-title', 'pr-body', 'comment', 'commit-message']) {
    const result = scanPublication([{ kind, text }], {});
    assert.equal(result.status, 'blocked', kind);
    assert.equal(JSON.stringify(result).includes('someone'), false, kind);
  }
});

test('the result says whether any private material was supplied to compare against', () => {
  const unit = [{ kind: 'pr-body', text: 'plain text' }];
  for (const options of [undefined, {}, { memories: [] }, { rules: [], knownValues: [] }, { memories: undefined }, { knownValues: undefined }]) {
    assert.equal(scanPublication(unit, options).privateReference, 'none-supplied', JSON.stringify(options));
  }
  assert.notEqual(scanPublication(unit, { memories: 'x' }).status, 'clear', 'malformed private material is never a clear result');
  assert.equal(scanPublication(unit, { memories: [{ id: 'm', content: 'some private note text here' }] }).privateReference, 'supplied');
  assert.equal(scanPublication(unit, { rules: [{ id: 'r', text: 'some private rule text here' }] }).privateReference, 'supplied');
  assert.equal(scanPublication(unit, { knownValues: [{ id: 'k', value: 'private-value' }] }).privateReference, 'supplied');
});
