'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('the walkthrough VS Code shows after install: the Workbench, then the five first steps, each button an existing command (#357)', () => {
  const walkthroughs = manifest.contributes.walkthroughs;
  assert.equal(walkthroughs.length, 1);
  const [walkthrough] = walkthroughs;
  assert.deepEqual(walkthrough.steps.map((step) => step.id), ['workbench', 'account', 'role', 'agent', 'task', 'review']);
  const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const step of walkthrough.steps) {
    // Every button and every way the step is done names a command the extension contributes; nothing else is run.
    const links = [...step.description.matchAll(/\]\(command:([A-Za-z.]+)(?:\?([^)]*))?\)/g)];
    assert.equal(links.length, 1, `${step.id}: one button`);
    assert.ok(commands.has(links[0][1]), `${step.id}: ${links[0][1]} is contributed`);
    if (links[0][2] !== undefined) assert.deepEqual(JSON.parse(decodeURIComponent(links[0][2])), [{ tab: 'work' }], `${step.id}: only a tab name is passed`);
    assert.ok(step.completionEvents.length > 0);
    for (const event of step.completionEvents) assert.ok(event.startsWith('onCommand:') && commands.has(event.slice('onCommand:'.length)), `${step.id}: ${event}`);
    // Its page is a file in the package (media is not left out of it) and says nothing that is not plain text.
    const file = path.join(ROOT, step.media.markdown);
    assert.ok(step.media.markdown.startsWith('media/walkthrough/') && fs.existsSync(file), step.media.markdown);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /<|command:|https?:/, `${step.id}: no HTML, links or commands in its page`);
  }
});

test('the extension still starts only when it is used: no start with every window (#357, PM decision A + C)', () => {
  assert.equal(manifest.activationEvents.some((event) => event === '*' || event === 'onStartupFinished'), false);
});
