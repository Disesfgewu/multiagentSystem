'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { sessionsByRecency, addressOf, parseAddress, UsageLog, entryFromSnapshot, validateEntry, rotate, describeLog, exportRows, toCsv, toJson, MAX_ENTRIES_PER_ACCOUNT, MAX_AGE_MS } = require('../../src/accounts/usage-log');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const NOW = new Date('2026-10-21T10:00:00.000Z');
const obs = (field, value, confidence = 'actual', observedAt = '2026-10-21T09:59:00.000Z', source = 'claude.status-line') => ({ field, value, unit: field.endsWith('usd') ? 'usd' : 'tokens', scope: 'bound local session', source, observedAt, confidence });
const unknownObs = (field) => ({ field, value: null, unit: null, scope: null, source: 'claude.status-line', observedAt: '2026-10-21T09:59:00.000Z', confidence: 'unknown', reason: 'not-reported' });
const snapshot = (over = {}) => ({
  sessionId: 'session-1', provider: 'claude', accountProfileId: 'profile-a',
  model: { field: 'session.model', value: 'claude-3-7-sonnet-20250219', confidence: 'actual' },
  usage: [obs('usage.input_tokens', 1200), obs('usage.output_tokens', 300), obs('usage.cache_read_tokens', 50), unknownObs('usage.cache_write_tokens'), obs('usage.cost_usd', 0.0123, 'estimated', '2026-10-21T09:59:30.000Z', 'claude.status-line.local-estimate')],
  ...over
});
const entry = (over = {}) => ({ at: '2026-10-21T09:59:30.000Z', sessionId: 'session-1', provider: 'claude', accountProfileId: 'profile-a', model: 'claude-3-7-sonnet-20250219', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: null, costUsd: 0.0123, measurement: 'mixed', source: 'claude.status-line', ...over });
function open(t) {
  const box = sandbox(t);
  const store = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: [...COLLECTIONS] });
  return { store, log: () => new UsageLog(store()) };
}

test('an entry comes from what the provider reported: unknown figures stay unknown, estimates are marked, the newest time is used', () => {
  const made = entryFromSnapshot(snapshot());
  assert.deepEqual({ ...made }, entry());
  assert.equal(made.cacheWriteTokens, null, 'a figure that was not reported is not zero');
  assert.equal(entryFromSnapshot(snapshot({ usage: [obs('usage.input_tokens', 5)] })).measurement, 'actual');
  assert.equal(entryFromSnapshot(snapshot({ usage: [obs('usage.input_tokens', 5, 'estimated')] })).measurement, 'estimated');
});

test('nothing is made of a snapshot with no reported usage: unknown, missing or malformed readings are not entries', () => {
  const allUnknown = ['usage.input_tokens', 'usage.output_tokens', 'usage.cache_read_tokens', 'usage.cache_write_tokens', 'usage.cost_usd'].map(unknownObs);
  for (const bad of [null, undefined, {}, snapshot({ usage: allUnknown }), snapshot({ usage: [] }), snapshot({ usage: 'x' }), snapshot({ usage: [obs('usage.input_tokens', -1)] }), snapshot({ usage: [obs('usage.input_tokens', Number.NaN)] }), snapshot({ sessionId: 'a b' }), snapshot({ provider: 'Claude Code' })]) {
    assert.equal(entryFromSnapshot(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  const codexLike = { sessionId: 's', provider: 'codex', accountProfileId: 'p', status: unknownObs('session.state'), model: unknownObs('session.model'), usage: allUnknown.map((item) => ({ ...item, source: 'not-observed' })), freshness: 'unknown' };
  assert.equal(entryFromSnapshot(codexLike), null, 'a provider with no source (Codex, agy) writes nothing, not zeros');
  assert.equal(entryFromSnapshot(snapshot({ model: unknownObs('session.model') })).model, null, 'an unreported model is not guessed');
  assert.equal(entryFromSnapshot(snapshot({ usage: [obs('usage.input_tokens', 5, 'unknown'), obs('usage.output_tokens', 7, 'guess')] })), null, 'only actual or estimated figures count, whatever number a reading carries');
});

test('readings are appended, listed newest first, filtered by account and session; the same reading twice is one entry', (t) => {
  const { log } = open(t);
  assert.deepEqual(log().append(entry(), NOW), { ok: true, appended: true });
  assert.deepEqual(log().append(entry(), NOW), { ok: true, appended: false });
  assert.equal(log().append(entry({ at: '2026-10-21T09:59:40.000Z', inputTokens: 1300 }), NOW).appended, true);
  assert.equal(log().append(entry({ sessionId: 'session-2', accountProfileId: 'profile-b', at: '2026-10-21T09:58:00.000Z' }), NOW).appended, true);
  const all = log().query().entries;
  assert.deepEqual(all.map((item) => [item.sessionId, item.at]), [['session-1', '2026-10-21T09:59:40.000Z'], ['session-1', '2026-10-21T09:59:30.000Z'], ['session-2', '2026-10-21T09:58:00.000Z']]);
  assert.equal(log().query({ accountProfileId: 'profile-b' }).entries.length, 1);
  assert.equal(log().query({ sessionId: 'session-1' }).entries.length, 2);
  assert.deepEqual(log().query({ accountProfileId: 'nobody' }), { ok: true, entries: [] });
});

test('the log rotates: entries older than the limit and beyond the count are dropped, newest kept', () => {
  const day = 24 * 60 * 60 * 1000;
  const make = (index) => entry({ at: new Date(NOW.getTime() - index * 60_000).toISOString() });
  const many = Array.from({ length: MAX_ENTRIES_PER_ACCOUNT + 30 }, (_, index) => make(index)).reverse();
  const kept = rotate(many, NOW);
  assert.equal(kept.length, MAX_ENTRIES_PER_ACCOUNT);
  assert.equal(kept.at(-1).at, make(0).at, 'the newest survives');
  const old = rotate([entry({ at: new Date(NOW.getTime() - MAX_AGE_MS - day).toISOString() }), make(0)], NOW);
  assert.deepEqual(old.map((item) => item.at), [make(0).at], 'an entry past the age limit is dropped');
});

test('a stored record that cannot be read is an error, not an empty log; an invalid entry is refused before anything is written', (t) => {
  const { store, log } = open(t);
  assert.deepEqual(log().append({ ...entry(), inputTokens: -5 }, NOW), { ok: false, reason: 'invalid-entry' });
  assert.deepEqual(log().append({ ...entry(), inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null }, NOW), { ok: false, reason: 'invalid-entry' });
  assert.equal(log().query().entries.length, 0);
  store().put('usageLog', 'broken', { schemaVersion: 1, entries: [{ nonsense: true }] });
  assert.deepEqual(log().query(), { ok: false, reason: 'invalid-usage-record' });
  assert.deepEqual(log().append(entry(), NOW), { ok: true, appended: true }, 'a different account is unaffected by a broken record elsewhere');
  const broken = { get: () => ({ ok: false }), list: () => ({ ok: false, reason: 'store-unavailable' }), transact: () => ({ ok: false, reason: 'store-unavailable' }) };
  assert.deepEqual(new UsageLog(broken).query(), { ok: false, reason: 'store-unavailable' });
  assert.deepEqual(new UsageLog(broken).append(entry(), NOW), { ok: false, reason: 'store-unavailable' });
  for (const bad of [undefined, null, {}, { get: () => {} }]) assert.throws(() => new UsageLog(bad), TypeError);
});

test('what is stored holds no prompt, path or credential: only the fixed fields, and nothing else is accepted', () => {
  const checked = validateEntry({ ...entry(), prompt: 'secret prompt', path: '/synthetic/project', token: 'abc', label: 'My Account' });
  assert.equal(checked.ok, true);
  assert.deepEqual(Object.keys(checked.entry).sort(), ['accountProfileId', 'at', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'inputTokens', 'measurement', 'model', 'outputTokens', 'provider', 'sessionId', 'source']);
  assert.equal(JSON.stringify(checked.entry).includes('secret prompt'), false);
});

test('the log document marks estimates, shows a dash for a missing figure and says why a provider has no entries', () => {
  const lines = describeLog([entry({ measurement: 'estimated' }), entry({ inputTokens: 5, cacheReadTokens: null, costUsd: null, measurement: 'actual' })], { labelFor: () => 'Main', providerLabel: () => 'Claude Code' }).join('\n');
  assert.match(lines, /ESTIMATE/);
  assert.match(lines, /cache read —/);
  assert.match(lines, /cost —/);
  assert.match(lines, /cost \$0\.0123/);
  assert.match(lines, /Do not publish/);
  assert.match(describeLog([]).join('\n'), /Codex and agy have none connected, so nothing is shown for them \(unknown, not zero\)/);
});

test('an export is masked: accounts and sessions are not named, and no path or label is in the file', () => {
  const rows = exportRows([entry({ accountProfileId: 'profile-secret-label', sessionId: 'session-private-id' }), entry({ accountProfileId: 'profile-b', sessionId: 'session-2' }), entry({ accountProfileId: 'profile-secret-label', sessionId: 'session-3' })]);
  assert.deepEqual(rows.map((row) => row.account), ['account-1', 'account-2', 'account-1']);
  for (const text of [toCsv(rows), toJson(rows)]) {
    for (const secret of ['profile-secret-label', 'session-private-id', 'profile-b', '/home', 'Account']) assert.equal(text.includes(secret), false, secret);
  }
  const csv = toCsv(rows).split('\n');
  assert.equal(csv[0], 'time,account,session,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,measurement,source');
  assert.equal(csv.length, 5);
  assert.equal(JSON.parse(toJson(rows)).masked, true);
});

test('a CSV cell that a spreadsheet would run as a formula is kept as text; quotes and commas are escaped', () => {
  const [row] = exportRows([entry({ model: '=cmd|calc', source: 'a.b' })]);
  assert.match(toCsv([row]), /,'=cmd\|calc,/);
  const quoted = toCsv([{ ...row, model: 'a,"b"' }]);
  assert.match(quoted, /"a,""b"""/);
});

const { recordReading } = require('../../src/accounts/usage-log');

test('a reading is kept when something was reported, once, and a snapshot with nothing reported opens no storage', async (t) => {
  const { store, log } = open(t);
  let opened = 0;
  const openStore = async () => { opened += 1; return store(); };
  assert.deepEqual(await recordReading({ snapshot: snapshot(), openStore, now: NOW }), { recorded: true, reason: 'recorded' });
  assert.deepEqual(await recordReading({ snapshot: snapshot(), openStore, now: NOW }), { recorded: false, reason: 'unchanged' });
  assert.equal(log().query().entries.length, 1);
  const before = opened;
  const nothing = { ...snapshot(), usage: [unknownObs('usage.input_tokens')] };
  assert.deepEqual(await recordReading({ snapshot: nothing, openStore, now: NOW }), { recorded: false, reason: 'nothing-reported' });
  assert.deepEqual(await recordReading({ snapshot: null, openStore, now: NOW }), { recorded: false, reason: 'nothing-reported' });
  assert.equal(opened, before, 'no storage was opened for nothing');
});

test('storage that is unavailable or throws keeps nothing and never throws: a session is never disturbed by its own log', async () => {
  assert.deepEqual(await recordReading({ snapshot: snapshot(), openStore: async () => null, now: NOW }), { recorded: false, reason: 'storage-unavailable' });
  assert.deepEqual(await recordReading({ snapshot: snapshot(), openStore: async () => { throw new Error('boom'); }, now: NOW }), { recorded: false, reason: 'failed' });
  assert.deepEqual(await recordReading({ snapshot: snapshot(), openStore: async () => ({ get: () => ({ ok: false }), list: () => ({ ok: false }), transact: () => ({ ok: false, reason: 'store-unavailable' }) }), now: NOW }), { recorded: false, reason: 'store-unavailable' });
});

const later = (minutes, over = {}) => entry({ at: new Date(Date.parse('2026-10-21T09:59:30.000Z') + minutes * 60_000).toISOString(), ...over });

test('a reading that says the same as the session\'s latest one is not logged again; a change, another session or another model is', (t) => {
  const { log } = open(t);
  assert.deepEqual(log().append(later(0), NOW), { ok: true, appended: true });
  assert.deepEqual(log().append(later(1), NOW), { ok: true, appended: false }, 'the status line repeating itself');
  assert.deepEqual(log().append(later(2), NOW), { ok: true, appended: false });
  assert.deepEqual(log().append(later(3, { outputTokens: 301 }), NOW), { ok: true, appended: true }, 'a figure changed');
  assert.deepEqual(log().append(later(4, { outputTokens: 301 }), NOW), { ok: true, appended: false }, 'the same as the new latest one');
  assert.deepEqual(log().append(later(5, { outputTokens: 301, sessionId: 'session-2' }), NOW), { ok: true, appended: true }, 'another session has its own latest');
  assert.deepEqual(log().append(later(6, { outputTokens: 301, model: 'claude-other' }), NOW), { ok: true, appended: true }, 'another model');
  assert.deepEqual(log().append(later(7, { outputTokens: 301, costUsd: 0.5 }), NOW), { ok: true, appended: true }, 'another cost');
  assert.deepEqual(log().append(later(8, { outputTokens: 301, measurement: 'actual' }), NOW), { ok: true, appended: true }, 'another measurement');
  assert.equal(log().query().entries.length, 6);
});

test('an older identical reading does not hide a later change, and a figure that went back to an earlier value is a new reading', (t) => {
  const { log } = open(t);
  log().append(later(0), NOW); log().append(later(10, { outputTokens: 400 }), NOW);
  assert.deepEqual(log().append(later(20), NOW), { ok: true, appended: true }, 'back to the first figures, after a different latest one');
  assert.deepEqual(log().append(later(5), NOW), { ok: true, appended: false }, 'a reading older than the latest is compared with the latest (same figures: not new)');
  assert.deepEqual(log().append(later(6, { outputTokens: 7 }), NOW), { ok: true, appended: true }, 'and a different one is new');
});

test('a stored record that cannot be read makes the append an error and leaves the record exactly as it was', (t) => {
  const { store, log } = open(t);
  assert.equal(log().append(later(0), NOW).ok, true);
  const listed = store().list('usageLog').items[0];
  const bad = { ...listed.value, entries: [{ nonsense: true }] };
  assert.equal(store().transact((tx) => { tx.put('usageLog', listed.id, bad); return true; }).ok, true);
  assert.deepEqual(log().append(later(1, { outputTokens: 5 }), NOW), { ok: false, reason: 'invalid-usage-record' });
  assert.deepEqual(store().get('usageLog', listed.id).value, bad, 'the stored record is unchanged');
  assert.deepEqual(log().query(), { ok: false, reason: 'invalid-usage-record' });
});

test('the log can be read for one session, and the document says so', (t) => {
  const { log } = open(t);
  log().append(later(0), NOW); log().append(later(1, { sessionId: 'session-2', outputTokens: 9 }), NOW);
  assert.deepEqual(log().query({ sessionId: 'session-2' }).entries.map((item) => item.sessionId), ['session-2']);
  assert.deepEqual(log().query({ sessionId: 'nope' }).entries, []);
  assert.deepEqual(log().query({ accountProfileId: 'profile-a', sessionId: 'session-1' }).entries.map((item) => item.sessionId), ['session-1']);
  const lines = describeLog(log().query({ sessionId: 'session-2' }).entries, { sessionLabel: 'Worker (session-2)' });
  assert.ok(lines.includes('Showing one session only: Worker (session-2).'));
  assert.equal(describeLog([]).some((line) => line.startsWith('Showing one session')), false);
});

test('a document address names an account (or all) and at most one session, and anything else is refused', () => {
  assert.equal(addressOf('profile-a'), 'profile-a');
  assert.equal(addressOf('profile-a', 'session-1'), 'profile-a~session-1');
  assert.deepEqual(parseAddress('profile-a'), { account: 'profile-a' });
  assert.deepEqual(parseAddress('*'), { account: '*' });
  assert.deepEqual(parseAddress('profile-a~session-1'), { account: 'profile-a', session: 'session-1' });
  assert.deepEqual(parseAddress('*~session-1'), { account: '*', session: 'session-1' });
  for (const bad of ['', 'a b', 'a~', 'a~b~c', '~s', 'a~b c', '../x', 'a~../x', 5, null, undefined, 'x'.repeat(101)]) assert.equal(parseAddress(bad), undefined, String(bad));
});

test('the log command offers the sessions that are in the log, only when there is more than one, and reads with the chosen one', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../src/accounts/usageLogCommands.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /if \(ids\.length < 2\) return \{ cancelled: false \};/);
  assert.match(source, /const read = await readEntries\(address\.account, address\.session\);/);
  assert.match(source, /query: addressOf\(account, chosen\.session\)/);
  assert.match(source, /\.\.\.\(sessionId \? \{ sessionId \} : \{\}\)/);
});

test('each of the seven fields alone makes a reading new: a change in only that field is logged, and none of them is ignored', (t) => {
  const changes = { inputTokens: 1201, outputTokens: 301, cacheReadTokens: 51, cacheWriteTokens: 7, costUsd: 0.0124, model: 'claude-other', measurement: 'actual' };
  assert.deepEqual(Object.keys(changes).sort(), ['cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'inputTokens', 'measurement', 'model', 'outputTokens']);
  for (const [field, value] of Object.entries(changes)) {
    const { log } = open(t);
    assert.deepEqual(log().append(later(0), NOW), { ok: true, appended: true }, field);
    assert.notEqual(later(0)[field], value, `${field}: the changed value differs from the first reading`);
    assert.deepEqual(log().append(later(1, { [field]: value }), NOW), { ok: true, appended: true }, `${field} alone changed: a new reading`);
    assert.deepEqual(log().append(later(2, { [field]: value }), NOW), { ok: true, appended: false }, `${field}: and then the repeat of that is not new`);
    assert.equal(log().query().entries.length, 2, field);
  }
});

test('the fields that decide sameness are exactly the seven, and the time and the session are not among them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../src/accounts/usage-log.js'), 'utf8');
  const listed = /const SAME_READING = Object\.freeze\(\[([^\]]*)\]\)/.exec(source)[1].split(',').map((item) => item.trim().replace(/'/g, '')).sort();
  assert.deepEqual(listed, ['cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'inputTokens', 'measurement', 'model', 'outputTokens']);
});

test('when there are too many sessions the ones kept are those with the most recent readings, whatever order the list is in', () => {
  const entries = [];
  for (let index = 0; index < 60; index += 1) entries.push(entry({ sessionId: `s-${String(index).padStart(2, '0')}`, at: new Date(Date.parse('2026-10-21T00:00:00.000Z') + index * 60_000).toISOString() }));
  // The newest session also has an old reading listed first; its latest one still counts.
  entries.unshift(entry({ sessionId: 's-59', at: '2026-10-20T00:00:00.000Z' }));
  for (const list of [entries, [...entries].reverse(), [...entries].sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1))]) {
    const kept = sessionsByRecency(list, 50);
    assert.equal(kept.length, 50);
    assert.equal(kept[0], 's-59');
    assert.equal(kept[49], 's-10');
    assert.ok(!kept.includes('s-09') && !kept.includes('s-00'), 'the oldest sessions are the ones left out');
  }
  assert.deepEqual(sessionsByRecency([entry({ sessionId: 'a', at: '2026-10-21T00:00:00.000Z' }), entry({ sessionId: 'b', at: '2026-10-21T00:00:00.000Z' })], 5), ['a', 'b'], 'equal times: by id');
  for (const bad of [undefined, null, 'x', [null, 5, {}, { sessionId: 3 }, { sessionId: 'x', at: 'never' }]]) assert.deepEqual(sessionsByRecency(bad), []);
});
