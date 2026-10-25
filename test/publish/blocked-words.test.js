'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, blockedSentence } = require('../../src/publish/blocked-words');

test('the message says which kind of private data stopped a post and where it is kept, never the value (#389)', () => {
  assert.equal(describe({ category: 'known-value', id: 'profiles:abc123:email' }), 'an account e-mail address (Accounts tab)');
  assert.equal(describe({ category: 'known-value', id: 'accountChecks:abc123:account.organization' }), 'an account organization name (Accounts tab)');
  assert.equal(describe({ category: 'known-value', id: 'profiles:abc123:label' }), 'an account name (Accounts tab)');
  assert.equal(describe({ category: 'known-value', id: 'profiles:abc123:name' }), 'an account name (Accounts tab)');
  assert.equal(describe({ category: 'known-value', id: 'profiles:abc123:configDir' }), 'a detail of one of your accounts (Accounts tab)');
  assert.equal(describe({ category: 'private-fragment', id: 'reportFeedback:abc123:note' }), 'your private note on a report (kept only on this machine)');
  assert.equal(describe({ category: 'known-value', id: 'broadcasts:abc123:text' }), 'the text of a broadcast you sent to agents');
  assert.equal(describe({ category: 'known-value', id: 'skills:abc123:body' }), 'a skill in the Knowledge tab');
  assert.equal(describe({ category: 'local-path' }), 'a folder or file path of this computer');
  assert.equal(describe({ category: 'credential' }), 'something that looks like a password, token or key');
  assert.equal(describe({ category: 'known-value', id: 'nowhere:1:x' }), 'a value kept privately on this machine');
  assert.equal(describe({ category: 'surprise' }), 'something private');
  assert.equal(describe(null), 'something private');
  // Array positions in a field path do not hide the field.
  assert.equal(describe({ category: 'known-value', id: 'profiles:abc123:emails.0' }), 'a detail of one of your accounts (Accounts tab)');
  assert.equal(describe({ category: 'known-value', id: 'profiles:abc123:account.email.0' }), 'an account e-mail address (Accounts tab)');
});

test('one sentence names each kind once, says what to do, and that nothing was sent (#389)', () => {
  assert.equal(blockedSentence([{ category: 'known-value', id: 'profiles:a:email' }, { category: 'known-value', id: 'profiles:b:email' }, { category: 'local-path' }]),
    ' It contains an account e-mail address (Accounts tab) and a folder or file path of this computer. Remove or reword that part and try again; nothing was sent.');
  assert.equal(blockedSentence([{ category: 'credential' }]), ' It contains something that looks like a password, token or key. Remove or reword that part and try again; nothing was sent.');
  assert.equal(blockedSentence([]), '');
  assert.equal(blockedSentence(undefined), '');
  assert.equal(blockedSentence('profiles:a:email'), '', 'only a list of findings is read');
});
