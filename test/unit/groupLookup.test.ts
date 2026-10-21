import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { findGroupTerminals, GroupTerminal } from '../../src/terminals/groupLookup';

const make = (name: string, exitStatus?: unknown): GroupTerminal => ({ name, exitStatus });
const TITLES = ['PM', 'Worker 1', 'Worker 2', 'Worker 3'];

test('terminals the extension created are found by reference even when the shell has renamed them', () => {
  const created = TITLES.map((title) => make(title));
  const owned = new Map(TITLES.map((title, index) => [title, created[index]]));
  for (const terminal of created) terminal.name = 'powershell.exe'; // retitled by the shell
  const found = findGroupTerminals(TITLES, created, owned);
  assert.deepEqual(found, created, 'all four are found; no second group would be created');
});

test('a name match is the fallback for a terminal from before this window\'s references', () => {
  const live = [make('PM'), make('Worker 2')];
  assert.deepEqual(findGroupTerminals(TITLES, live, new Map()), [live[0], undefined, live[1], undefined]);
});

test('a reference to a terminal that closed or exited is dropped, never returned', () => {
  const gone = make('PM');
  const exited = make('Worker 1', { code: 0 });
  const owned = new Map<string, GroupTerminal>([['PM', gone], ['Worker 1', exited]]);
  assert.deepEqual(findGroupTerminals(TITLES, [exited], owned), [undefined, undefined, undefined, undefined]);
  assert.equal(owned.size, 0, 'both references were dropped');
});

test('an exited terminal is not matched by name either', () => {
  const exited = make('PM', { code: 1 });
  assert.deepEqual(findGroupTerminals(TITLES, [exited], new Map())[0], undefined);
});

test('a reference is preferred over another terminal that happens to carry the same name', () => {
  const mine = make('powershell.exe');
  const lookalike = make('PM');
  const found = findGroupTerminals(['PM'], [lookalike, mine], new Map([['PM', mine]]));
  assert.equal(found[0], mine);
});
