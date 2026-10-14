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
