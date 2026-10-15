'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRoleGroup, TOOLS } = require('../../src/roles');
const { pmGroup, workerGroup } = require('./fixtures');

const codes = (result) => result.problems.map((problem) => `${problem.code}@${problem.path}`).sort();

test('a PM group and a worker group both validate and come back as clean, complete copies', () => {
  for (const input of [pmGroup(), workerGroup()]) {
    const before = JSON.stringify(input);
    const result = validateRoleGroup(input);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(JSON.stringify(input), before, 'the input is not modified');
    assert.notEqual(result.group, input);
    assert.deepEqual(Object.keys(result.group.toolPermissions).sort(), [...TOOLS].sort());
  }
  assert.equal(validateRoleGroup(workerGroup()).group.defaultAccountProfileId, null);
});

test('what is left out fails closed: tools are denied, memory is off, empty scope allows nothing', () => {
  const result = validateRoleGroup({
    id: 'minimal', name: 'Minimal', role: 'worker', provider: 'claude', version: 1,
    allowedScope: { repositories: [], paths: [] }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.values(result.group.toolPermissions), TOOLS.map(() => 'deny'));
  assert.deepEqual(result.group.memoryScope, { mode: 'off' });
  assert.deepEqual(result.group.allowedScope, { repositories: [], paths: [] });
  assert.deepEqual(result.group.rules, []);
});

test('role groups accept every built-in provider from the registry, including agy', () => {
  for (const provider of ['agy', 'claude', 'codex']) {
    const result = validateRoleGroup({
      id: 'group', name: 'Group', role: 'worker', provider, version: 1,
      allowedScope: { repositories: [], paths: [] }
    });
    assert.equal(result.ok, true, provider);
    assert.equal(result.group.provider, provider);
  }
  assert.equal(codes(validateRoleGroup({
    id: 'group', name: 'Group', role: 'worker', provider: 'opencode', version: 1,
    allowedScope: { repositories: [], paths: [] }
  })).includes('invalid-provider@provider'), true);
});

test('unknown fields are refused at every level, not ignored', () => {
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ admin: true }))), ['unknown-field@admin']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ allowedScope: { repositories: [], paths: [], network: [] } }))),
    ['unknown-field@allowedScope.network']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ toolPermissions: { shell: 'allow', browser: 'allow' } }))),
    ['unknown-tool@toolPermissions.browser']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', type: 'forbid', key: 'x', priority: 9 }] }))),
    ['unknown-field@rules[0].priority']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ memoryScope: { mode: 'off', share: 'all' } }))), ['invalid-memory-scope@memoryScope']);
});

test('wrong types and unsafe values are each named, with a code and a path', () => {
  const cases = [
    [{ id: '' }, 'invalid-id@id'],
    [{ id: 'has space' }, 'invalid-id@id'],
    [{ id: '../escape' }, 'invalid-id@id'],
    [{ name: '' }, 'invalid-name@name'],
    [{ name: 'two\nlines' }, 'invalid-name@name'],
    [{ name: 'x'.repeat(81) }, 'invalid-name@name'],
    [{ name: 'reads \u202ebackwards' }, 'invalid-name@name'],
    [{ role: 'PM' }, 'invalid-role@role'],
    [{ provider: 'gemini' }, 'invalid-provider@provider'],
    [{ version: 0 }, 'invalid-version@version'],
    [{ version: 1.5 }, 'invalid-version@version'],
    [{ version: '2' }, 'invalid-version@version'],
    [{ defaultAccountProfileId: 'has space' }, 'invalid-account-profile-id@defaultAccountProfileId'],
    [{ defaultAccountProfileId: 7 }, 'invalid-account-profile-id@defaultAccountProfileId'],
    [{ toolPermissions: { shell: 'maybe' } }, 'invalid-level@toolPermissions.shell'],
    [{ toolPermissions: 'allow' }, 'invalid-tool-permissions@toolPermissions'],
    [{ memoryScope: { mode: 'everyone' } }, 'invalid-memory-scope@memoryScope'],
    [{ allowedScope: undefined }, 'invalid-scope@allowedScope'],
    [{ allowedScope: { repositories: 'a/b', paths: [] } }, 'invalid-scope@allowedScope.repositories']
  ];
  for (const [change, expected] of cases) {
    const result = validateRoleGroup(pmGroup(change));
    assert.equal(result.ok, false, expected);
    assert.ok(codes(result).includes(expected), `${expected} in ${JSON.stringify(codes(result))}`);
  }
  assert.deepEqual(codes(validateRoleGroup(null)), ['not-an-object@']);
  assert.deepEqual(codes(validateRoleGroup([])), ['not-an-object@']);
  assert.deepEqual(codes(validateRoleGroup('pm')), ['not-an-object@']);
});

test('repository names must be owner/name and cannot be a relative component', () => {
  const bad = ['app', 'owner/', '/name', 'a/b/c', '../name', 'owner/..', './x', 'own er/name', 'owner/na me'];
  for (const repository of bad) {
    const result = validateRoleGroup(pmGroup({ allowedScope: { repositories: [repository], paths: [] } }));
    assert.deepEqual(codes(result), ['invalid-repository@allowedScope.repositories[0]'], repository);
  }
  const twice = validateRoleGroup(pmGroup({ allowedScope: { repositories: ['Example/App', 'example/app'], paths: [] } }));
  assert.deepEqual(codes(twice), ['duplicate-entry@allowedScope.repositories[1]'], 'repository names compare without case');
});

test('path scopes are plain relative prefixes; anything that could point elsewhere is refused', () => {
  const good = ['.', 'src', 'src/parser', 'test/fixtures', '.github', 'docs/p0'];
  assert.equal(validateRoleGroup(pmGroup({ allowedScope: { repositories: [], paths: good } })).ok, true);

  const bad = [
    '', '/etc', '/', '~', '~root/x', '../outside', 'a/../b', 'a/..', './a', 'a//b', 'a/', 'a/./b',
    'C:\\x', 'C:/x', 'a\\b', 'a:b', 'file:stream', 'bad\u0000name', 'tab\tname',
    'CON', 'src/aux.txt', 'nul', 'COM1', 'lpt9.log', 'trailing.', 'src/trailing ', 'x'.repeat(201)
  ];
  for (const path of bad) {
    const result = validateRoleGroup(pmGroup({ allowedScope: { repositories: [], paths: [path] } }));
    assert.deepEqual(codes(result), ['invalid-path@allowedScope.paths[0]'], JSON.stringify(path));
  }
  const dup = validateRoleGroup(pmGroup({ allowedScope: { repositories: [], paths: ['Src', 'src'] } }));
  assert.deepEqual(codes(dup), ['duplicate-entry@allowedScope.paths[1]']);
  const many = validateRoleGroup(pmGroup({ allowedScope: { repositories: [], paths: Array.from({ length: 101 }, (_, i) => `d${i}`) } }));
  assert.deepEqual(codes(many), ['invalid-scope@allowedScope.paths']);
});

test("a group's own rules are checked like any others, and cannot claim another layer or a reserved id", () => {
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', layer: 'platform', type: 'forbid', key: 'x' }] }))),
    ['layer-mismatch@rules[0].layer']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'rg:pm-group:deny:shell', type: 'forbid', key: 'x' }] }))),
    ['reserved-id@rules[0].id']);
  assert.equal(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', layer: 'roleGroup', type: 'forbid', key: 'x' }] })).ok, true,
    'restating its own layer is allowed');
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ id: `r${i}`, type: 'forbid', key: `k${i}` }));
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: tooMany }))), ['too-many-rules@rules']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: 'none' }))), ['rules-not-a-list@rules']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', type: 'instruction', key: 'x', text: 'ok' }] }))),
    ['unexpected-key@rules[0].key']);
  assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', type: 'forbid', key: 'x', text: 'ok' }] }))),
    ['unexpected-text@rules[0].text']);
});

test('problems carry codes and paths only, never the value that was wrong', () => {
  const secret = 'SYNTHETIC-VALUE-THAT-MUST-NOT-APPEAR';
  const result = validateRoleGroup(pmGroup({
    name: `${secret}\n`,
    provider: secret,
    defaultAccountProfileId: `${secret} x`,
    [`${secret} field`]: 1,
    allowedScope: { repositories: [secret], paths: [`${secret}\\x`] },
    toolPermissions: { shell: secret, [secret]: 'allow' },
    rules: [{ id: secret, type: 'instruction', text: `${secret}\u0000` }]
  }));
  assert.equal(result.ok, false);
  const text = JSON.stringify(result);
  assert.equal(text.includes('MUST-NOT-APPEAR'), false);
});

const withPaths = (...paths) => validateRoleGroup(pmGroup({ allowedScope: { repositories: [], paths } }));

test('path scopes refuse glob characters, Windows-reserved characters and anything that reads as a pattern', () => {
  for (const path of ['src/*', 'src/**', '*', 'src/a?b', 'src/a<b', 'src/a>b', 'src/a|b', 'src/"x', 'src/{a,b}x/*', 'src/a:b']) {
    // `{`, `,` and `}` are ordinary characters; only the entries with a refused character must fail.
    const refused = /[*?<>|":]/.test(path);
    assert.equal(withPaths(path).ok, !refused, path);
  }
  assert.equal(withPaths('src/{a,b}x').ok, true, 'braces and commas are plain characters, not refused');
});

test('path scopes refuse control and Unicode format characters, which would show a different path than is stored', () => {
  const hidden = [
    'src/\u202etxt.exe',     // right-to-left override
    'src/a\u200bb',          // zero-width space
    'src/a\u200cb',          // zero-width non-joiner
    'src/a\u200db',          // zero-width joiner
    'src/a\u2060b',          // word joiner
    'src/a\ufeffb',          // byte order mark
    'src/a\u00adb',          // soft hyphen
    'src/\u2066x\u2069',     // isolates
    'src/a\u0085b',          // C1 control
    'src/a\u007fb'           // delete
  ];
  for (const path of hidden) {
    assert.deepEqual(codes(withPaths(path)), ['invalid-path@allowedScope.paths[0]'], JSON.stringify(path));
  }
});

test('path scopes must be in NFC, and two spellings of one name are one entry', () => {
  const composed = 'src/é';          // e with acute, one code point
  const decomposed = 'src/é';       // e followed by a combining acute
  assert.equal(composed.normalize('NFC'), composed);
  assert.equal(withPaths(composed).ok, true);
  assert.deepEqual(codes(withPaths(decomposed)), ['invalid-path@allowedScope.paths[0]'], 'not NFC: refused, not repaired');
  assert.deepEqual(codes(withPaths(composed, 'SRC/É')), ['duplicate-entry@allowedScope.paths[1]'], 'the same name in another letter case');
  assert.deepEqual(withPaths(composed).group.allowedScope.paths, [composed], 'what is stored is exactly what was given');
});

test('path scopes refuse any .git segment, in any letter case and in its Windows short name', () => {
  for (const path of ['.git', '.GIT', '.Git', '.git/hooks', 'src/.git', 'src/.git/hooks/pre-commit', 'GIT~1', 'git~2/hooks', '.git.', '.git ']) {
    assert.deepEqual(codes(withPaths(path)), ['invalid-path@allowedScope.paths[0]'], path);
  }
  for (const path of ['.github', '.gitignore', 'src/.gitkeep', 'gitops', 'git', 'src/git~x', 'my.git.d']) {
    assert.equal(withPaths(path).ok, true, `${path} is an ordinary name`);
  }
});

test('names and rule text refuse zero-width and invisible characters, but keep joiners that some scripts need', () => {
  const hidden = ['a\u200bb', 'a\u200eb', 'a\u2060b', 'a\ufeffb', 'a\u00adb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\u202eb', 'a\u2066b'];
  for (const text of hidden) {
    assert.deepEqual(codes(validateRoleGroup(pmGroup({ name: text }))), ['invalid-name@name'], `name ${JSON.stringify(text)}`);
    assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', type: 'instruction', text }] }))),
      ['invalid-text@rules[0].text'], `text ${JSON.stringify(text)}`);
  }
  // Built from code points so this file never has to contain the characters themselves.
  for (const code of [0x061c, 0x200e, 0x200f, 0x2062, 0x2064]) {
    const text = `a${String.fromCodePoint(code)}b`;
    assert.deepEqual(codes(validateRoleGroup(pmGroup({ name: text }))), ['invalid-name@name'], `name U+${code.toString(16)}`);
    assert.deepEqual(codes(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', type: 'instruction', text }] }))),
      ['invalid-text@rules[0].text'], `text U+${code.toString(16)}`);
  }
  const persian = 'می\u200cخواهم'; // contains a zero-width non-joiner
  assert.equal(validateRoleGroup(pmGroup({ name: persian })).ok, true);
  assert.equal(validateRoleGroup(pmGroup({ rules: [{ id: 'r1', type: 'instruction', text: `${persian}\nsecond line\twith a tab` }] })).ok, true);
});
