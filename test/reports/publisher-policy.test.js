'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publisherFor, mergeModeFor } = require('../../src/reports/publisherPolicy');

const publisher = (over = {}) => ({ ok: true, found: true, value: { kind: 'public-feedback-publisher-v1', repository: 'owner/repo-a', actorId: '42', login: 'pm-user', ...over } });
const merge = (over = {}) => ({ ok: true, found: true, value: { kind: 'merge-authority-policy-v1', repository: 'owner/repo-a', mode: 'pm', ...over } });

test('a publisher saved for one repository is not configured for another repository, even one a workspace remote points at', () => {
  assert.equal(publisherFor(publisher(), 'owner/repo-a').login, 'pm-user');
  assert.equal(publisherFor(publisher(), 'OWNER/Repo-A').login, 'pm-user', 'repository names compare without case');
  assert.equal(publisherFor(publisher(), 'owner/repo-b'), null);
  assert.equal(publisherFor(publisher(), 'attacker/repo-a'), null);
  assert.equal(publisherFor(publisher({ repository: undefined }), 'owner/repo-a'), null, 'a record with no repository counts for none');
});

test('publisher: unreadable and absent stay what they were; a malformed record is unreadable, not configured', () => {
  assert.equal(publisherFor({ ok: false }, 'owner/repo-a'), 'unreadable');
  assert.equal(publisherFor(undefined, 'owner/repo-a'), 'unreadable');
  assert.equal(publisherFor({ ok: true, found: false }, 'owner/repo-a'), null);
  assert.equal(publisherFor(publisher({ actorId: 'abc' }), 'owner/repo-a'), 'unreadable');
  assert.equal(publisherFor(publisher({ kind: 'other' }), 'owner/repo-a'), 'unreadable');
});

test('a PM merge policy saved for one repository gives the safe default, human, for any other', () => {
  assert.equal(mergeModeFor(merge(), 'owner/repo-a'), 'pm');
  assert.equal(mergeModeFor(merge(), 'owner/repo-b'), 'human');
  assert.equal(mergeModeFor(merge({ repository: undefined }), 'owner/repo-a'), 'human');
  assert.equal(mergeModeFor(merge({ mode: 'human' }), 'owner/repo-b'), 'human');
});

test('merge policy: absent is human, unreadable and malformed fail closed', () => {
  assert.equal(mergeModeFor({ ok: true, found: false }, 'owner/repo-a'), 'human');
  assert.equal(mergeModeFor({ ok: false }, 'owner/repo-a'), 'unreadable');
  assert.equal(mergeModeFor(merge({ mode: 'admin' }), 'owner/repo-a'), 'unreadable');
  assert.equal(mergeModeFor(merge({ kind: 'x' }), 'owner/repo-a'), 'unreadable');
});
