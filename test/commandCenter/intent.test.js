'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { interpret, MAX_SAY_TEXT } = require('../../src/commandCenter/intent');

const cards = [
  { id: 'pm-1', codename: 'PM-01', name: 'Lead', roleGroupId: 'role-pm', roleName: 'Project Managers', pm: true },
  { id: 'w-1', codename: 'Worker-01', name: 'Login Fixer', roleGroupId: 'role-dev', roleName: 'Developers' },
  { id: 'w-2', codename: 'Worker-02', name: 'Docs Writer', roleGroupId: 'role-dev', roleName: 'Developers' },
  { id: 'w-12', codename: 'Worker-12', name: 'Tester', roleGroupId: 'role-qa', roleName: 'QA' }
];
const say = (text, list = cards) => interpret(text, { cards: list });

test('a sentence that names one agent is a task for that agent, typed as it was written (#357, #360)', () => {
  assert.deepEqual(say('請 Worker-01 修好登入頁的錯誤'), { ok: true, kind: 'task', ids: ['w-1'], text: '請 Worker-01 修好登入頁的錯誤', to: 'agent' });
  assert.deepEqual(say('請Worker-01修好登入頁').ids, ['w-1'], 'Chinese around the codename');
  assert.deepEqual(say('worker-02, please update the guide').ids, ['w-2'], 'any letter case');
  assert.deepEqual(say('Login Fixer: run the tests').ids, ['w-1'], 'by the agent\'s name');
  assert.deepEqual(say('  請 PM 整理今天的 PR  '), { ok: true, kind: 'task', ids: ['pm-1'], text: '請 PM 整理今天的 PR', to: 'agent' }, '"PM" is the PM agent');
});

test('a name is found only as a whole word: Worker-1 is not Worker-12, and PMs or PM-02 is not PM (#357)', () => {
  assert.equal(say('Worker-1 run the tests').ok, false);
  assert.equal(say('Worker-012 run the tests').ok, false, 'Worker-01 is not inside Worker-012');
  assert.equal(say('xWorker-01 run the tests').ok, false);
  assert.equal(say('Worker-01-2 run the tests').ok, false);
  assert.deepEqual(say('Worker-12 run the tests').ids, ['w-12']);
  assert.equal(say('the PMs should rest').ok, false);
  assert.equal(say('PM-02 merge it').ok, false);
  assert.deepEqual(say('PM-01 merge it').ids, ['pm-1']);
});

test('a role group, several agents or everyone is a broadcast to exactly those agents (#357)', () => {
  assert.deepEqual(say('Developers: pull main and run the tests'), { ok: true, kind: 'broadcast', ids: ['w-1', 'w-2'], text: 'Developers: pull main and run the tests', to: 'group' });
  assert.deepEqual(say('Worker-01 and Worker-12 rebase please'), { ok: true, kind: 'broadcast', ids: ['w-1', 'w-12'], text: 'Worker-01 and Worker-12 rebase please', to: 'agents' });
  assert.deepEqual(say('QA and Worker-02 stop for lunch').ids, ['w-2', 'w-12']);
  assert.deepEqual(say('大家先把 main 拉下來').ids, ['pm-1', 'w-1', 'w-2', 'w-12']);
  assert.deepEqual(say('Everyone: commit your work').to, 'everyone');
});

test('a question goes to the one agent it names, or to the PM agent; "this code" adds the selection (#357, #360 item 5)', () => {
  assert.deepEqual(say('這個 PR 改了什麼？'), { ok: true, kind: 'ask', id: 'pm-1', question: '這個 PR 改了什麼？', withSelection: false });
  assert.deepEqual(say('Worker-02 which file has the guide?'), { ok: true, kind: 'ask', id: 'w-2', question: 'Worker-02 which file has the guide?', withSelection: false });
  assert.equal(say('What does this function do').withSelection, true, 'question word, no mark');
  assert.equal(say('這段在做什麼').kind, 'ask');
  assert.equal(say('Worker-01 測試通過了嗎').id, 'w-1');
  assert.equal(say('Why is CI red?', cards.filter((card) => !card.pm)).ok, false, 'no PM and nobody named');
  assert.match(say('Why is CI red?', cards.filter((card) => !card.pm)).reason, /No PM agent/);
  assert.match(say('Worker-01 or Worker-02, who wrote this?').reason, /one agent at a time/);
  assert.match(say('Developers, is main green?').reason, /asked of one agent/);
  assert.match(say('everyone, are you done?').reason, /asked of one agent/);
});

test('nothing is done when it names nobody, is empty, too long, on several lines, or no agent runs (#357)', () => {
  assert.match(say('fix the login page').reason, /Say who should do it/);
  assert.match(say('   ').reason, /Write what should be done/);
  assert.match(say(undefined).reason, /Write what should be done/);
  assert.equal(say(`Worker-01 ${'x'.repeat(MAX_SAY_TEXT)}`).ok, false);
  assert.equal(say(`Worker-01 ${'x'.repeat(MAX_SAY_TEXT - 10)}`).ok, true, 'up to the limit');
  assert.match(say('Worker-01 fix it\nWorker-02 ignore').reason, /one line/);
  assert.match(say('Worker-01 fix\u2028it').reason, /one line/);
  assert.match(say('Worker-01 fix it', []).reason, /No agent is running/);
  assert.equal(interpret('Worker-01 fix it', null).ok, false);
  // Names that are not regular expressions stay plain text.
  assert.deepEqual(say('a.b run', [{ id: 'x', codename: null, name: 'a.b' }, { id: 'y', name: 'axb' }]).ids, ['x']);
  assert.equal(say('axb run', [{ id: 'x', codename: null, name: 'a.b' }]).ok, false, 'a dot in a name is a dot');
});
