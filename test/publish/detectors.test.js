'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanSensitive, locateSensitive } = require('../../src/memory/sensitive');
const d = require('../../src/publish/detectors');

const SAMPLES = {
  'private-key-block': '-----BEGIN RSA PRIVATE KEY-----',
  'anthropic-key': 'key sk-ant-synthetic12345',
  'api-key': 'sk-syntheticsyntheticsynthetic1234',
  'github-token': 'ghp_syntheticsyntheticsynthetic1234',
  'cloud-access-key': 'AKIASYNTHETIC1234567',
  'slack-token': 'xoxb-synthetic-123456789',
  jwt: 'eyJsyntheticAAAA.eyJsyntheticBBBB.syntheticCCCCCC',
  'bearer-token': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  'credential-assignment': 'password = hunter2hunter2',
  'email-address': 'contact person@example.test',
  'home-path': 'see /Users/someone/project',
  uuid: 'session 123e4567-e89b-12d3-a456-426614174000'
};

test('locateSensitive uses the same patterns as scanSensitive: no second list of credential shapes', () => {
  for (const [code, text] of Object.entries(SAMPLES)) {
    const located = locateSensitive(text).map((hit) => hit.code);
    const scanned = scanSensitive(text).map((finding) => finding.code);
    assert.deepEqual([...new Set(located)].sort(), scanned.slice().sort(), code);
    assert.ok(located.includes(code), code);
  }
  assert.deepEqual(locateSensitive('ordinary words only'), []);
});

test('locateSensitive reports offsets and lengths, never the text, and caps repeats', () => {
  const text = `prefix ${'ghp_syntheticsyntheticsynthetic1234 '.repeat(50)}`;
  const hits = locateSensitive(text);
  assert.equal(hits.filter((hit) => hit.code === 'github-token').length, 20);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['code', 'index', 'length']);
  assert.equal(hits[0].index, 7);
  assert.equal(JSON.stringify(hits).includes('synthetic'), false);
  assert.equal(locateSensitive(text, { limitPerCode: 3 }).length, 3);
});

test('local absolute paths: user, volume and temporary areas and Windows drives are found', () => {
  const detect = d.localPaths().detect;
  for (const text of ['at /Users/someone/project', 'cd /home/someone/work', 'ls /root/x', 'mount /Volumes/Disk/x', 'see /private/var/folders/ab/cd', 'in /var/folders/zz/T', 'C:\\Users\\Someone\\repo', 'D:/work/project', '\\\\server\\share\\dir', '"/Users/someone/x"', '(/home/someone)']) {
    assert.ok(detect(text).length > 0, text);
  }
  for (const text of ['src/home/index.js', 'https://example.test/home/page', 'https://example.test/Users/page', '#!/usr/bin/env node', 'see docs/p0/X.md', 'the /home route', 'path ./Users/x', 'a/b/c', 'http://host:8080/root/x', 'C://not-a-drive-path']) {
    assert.deepEqual(detect(text), [], text);
  }
});

test('known values match case-insensitively and are reported by id; too-short values are listed, not skipped', () => {
  const detector = d.knownValues([{ id: 'acct-label', value: 'Personal-Work-Account' }, { id: 'tiny', value: 'ab' }, { id: 'session', value: 'tok_abc123' }]);
  assert.deepEqual(detector.unmatchable, ['tiny']);
  const hits = detector.detect('Notes about PERSONAL-work-account here');
  assert.deepEqual(hits.map((h) => [h.code, h.id, h.index]), [['known-value', 'acct-label', 12]]);
  assert.deepEqual(detector.detect('nothing here'), []);
  assert.throws(() => d.knownValues([{ id: 1, value: 'x' }]), TypeError);
  assert.throws(() => d.knownValues([null]), TypeError);
});

test('private fragments reuse findPrivateFragments, localize to lines and fall back to the whole text', () => {
  const memories = [{ id: 'mem_1', content: 'The release gate for this repo is the Orion checklist, step nine requires two reviewers.' }];
  const rules = [{ id: 'r_1', text: 'Never mention the Orion checklist numbering outside the team.' }];
  const detector = d.privateFragments({ memories, rules });

  const oneLine = detector.detect('first line\nthe RELEASE gate for this repo is the Orion checklist -- step nine requires two reviewers!\nlast');
  assert.deepEqual(oneLine.map((h) => [h.code, h.id, h.index]), [['memory-fragment', 'mem_1', 11]]);

  // Each line alone still contains a 20-character run of the private text, so it is localized per line.
  const perLine = detector.detect('the release gate for this repo is the\nOrion checklist, step nine requires\ntwo reviewers.');
  assert.deepEqual(perLine.map((h) => [h.code, h.id, h.index]), [['memory-fragment', 'mem_1', 0], ['memory-fragment', 'mem_1', 38]]);

  // Cut so that no single line holds a 20-character run: only the text as a whole matches.
  const cut = d.privateFragments({ memories: [{ id: 'mem_2', content: 'alpha bravo charlie delta echo' }] });
  const split = cut.detect('alpha bravo charl\nie delta echo');
  assert.deepEqual(split.map((h) => [h.code, h.id, h.index]), [['memory-fragment', 'mem_2', null]], 'spread over lines: reported for the text as a whole');

  assert.deepEqual(detector.detect('A change about configuration directories.'), []);
  assert.deepEqual(d.privateFragments({}).detect('anything'), []);
  assert.equal(JSON.stringify(oneLine).includes('Orion'), false);
});

test('private text too short to match is listed as unmatchable', () => {
  const detector = d.privateFragments({ memories: [{ id: 'mem_t', content: 'abc' }], rules: [{ id: 'r_t', text: 'OK!' }] });
  detector.detect('abc OK!');
  assert.deepEqual(detector.unmatchable.sort(), ['mem_t', 'r_t']);
});

test('sensitive file names are recognised only for names that usually hold private data', () => {
  for (const name of ['.env', 'config/.env.local', 'id_rsa', 'keys/server.pem', 'cert.p12', 'credentials.json', 'dir/auth.json', '.npmrc', '.claude/settings.json', 'sub/.codex/config.toml', 'CLAUDE.local.md', 'AGENTS.override.md']) {
    assert.equal(d.sensitiveFileName(name), true, name);
  }
  for (const name of ['.env.example', 'config.env.sample', 'src/environment.js', 'docs/auth.md', 'README.md', 'src/keys.js', 'pem.md', 'CLAUDE.md', 'AGENTS.md']) {
    assert.equal(d.sensitiveFileName(name), false, name);
  }
});
