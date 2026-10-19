'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWrite } = require('../../src/reports/writeOutcome');

test('a verified success is done; a success reply that does not match what was sent is unknown, not refused', () => {
  assert.equal(classifyWrite({ ok: true, status: 201 }, true), 'done');
  assert.equal(classifyWrite({ ok: true, status: 201 }, false), 'unknown');
  assert.equal(classifyWrite({ ok: true, status: 200 }, false), 'unknown');
});

test('only definite client-side rejections are refused; server errors and timeouts may have created the comment', () => {
  for (const status of [400, 401, 403, 404, 409, 410, 422, 429]) assert.equal(classifyWrite({ ok: false, status }, false), 'refused', String(status));
  for (const status of [408, 500, 502, 503, 504, 520, 0]) assert.equal(classifyWrite({ ok: false, status }, false), 'unknown', String(status));
});
