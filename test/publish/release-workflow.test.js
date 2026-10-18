'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('build CI keeps review artifacts briefly with read-only permissions and never publishes a release', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v4/);
  assert.match(workflow, /artifacts\/multiagentsystem\.vsix/);
  assert.match(workflow, /artifacts\/release-candidate\.json/);
  assert.match(workflow, /retention-days: 14/);
  assert.doesNotMatch(workflow, /\bgh\s+release\b|\bvsce\s+publish\b|marketplace|contents:\s*write/i);
});
