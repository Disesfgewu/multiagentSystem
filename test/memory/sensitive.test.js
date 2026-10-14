'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanSensitive } = require('../../src/memory/sensitive');

const codes = (text) => scanSensitive(text).map((finding) => finding.code);

test('detects credential and identity shapes without returning the matched text', () => {
  const samples = {
    'anthropic-key': 'key sk-ant-synthetic12345',
    'github-token': 'ghp_syntheticsyntheticsynthetic1234',
    'email-address': 'contact person@example.test',
    'home-path': 'see /Users/someone/project',
    'uuid': 'session 123e4567-e89b-12d3-a456-426614174000',
    'private-key-block': '-----BEGIN RSA PRIVATE KEY-----',
    'bearer-token': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'credential-assignment': 'password = hunter2hunter2'
  };
  for (const [code, text] of Object.entries(samples)) {
    assert.ok(codes(text).includes(code), `${code} not detected`);
    assert.equal(JSON.stringify(scanSensitive(text)).includes('synthetic'), false);
  }
  assert.ok(codes('C:\\Users\\Someone\\repo').includes('home-path'));
});

test('ordinary project notes pass', () => {
  assert.deepEqual(codes('The build uses node --test and keeps tests under test/.'), []);
});

test('detection stays linear on very long input (no quadratic backtracking)', () => {
  const size = 150000;
  const inputs = ['a'.repeat(size), 'a@'.repeat(size / 2), ('token' + ' '.repeat(50)).repeat(size / 55), 'eyJ' + 'a'.repeat(size), 'a.b.c.'.repeat(size / 6) + '@', 'Bearer' + ' '.repeat(size)];
  const started = Date.now();
  for (const input of inputs) scanSensitive(input);
  // The old email pattern needed minutes for this; a generous bound keeps the test stable on slow runners.
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('an email address is still found at the start, middle and end of a run of text', () => {
  for (const text of ['person@example.test', 'mail: person@example.test.', 'x.y+z%w@sub.example.test!', 'a-b_c@d-e.test']) {
    assert.ok(codes(text).includes('email-address'), text);
  }
  for (const text of ['no at sign here', '@example.test', 'person@', 'person@host']) {
    assert.ok(!codes(text).includes('email-address'), text);
  }
});
