'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCodexRateLimits, codexUsageEntry, MAX_TAIL_BYTES, MAX_FILES_TRIED } = require('../../src/accounts/codex-rate-limits');
const { isFresh } = require('../../src/accounts/observation');

const posix = process.platform !== 'win32';
const NOW = new Date('2026-10-21T10:00:00.000Z');
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const epoch = (minutesFromNow) => Math.floor((NOW.getTime() + minutesFromNow * 60_000) / 1000);

const tokenCount = ({ minutesAgo = 1, primary = { used_percent: 42.5, window_minutes: 300, resets_at: epoch(120) }, secondary = { used_percent: 10, window_minutes: 10080, resets_at: epoch(60 * 24 * 3) }, plan = 'plus', info, rateLimits } = {}) => JSON.stringify({
  timestamp: at(minutesAgo), type: 'event_msg',
  payload: {
    type: 'token_count',
    info: info === undefined ? { total_token_usage: { input_tokens: 9000, output_tokens: 900 }, last_token_usage: { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1500 }, model_context_window: 200000 } : info,
    rate_limits: rateLimits === undefined ? { primary, secondary, plan_type: plan, credits: { has_credits: true, unlimited: false, balance: '5.00' }, rate_limit_reached_type: null } : rateLimits
  }
});
const noise = (text = 'PRIVATE-PROMPT-TEXT') => JSON.stringify({ timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

function home(t, files = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-codex-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}
const rollout = (day = '2026/10/21', name = 'rollout-2026-10-21T09-00-00-aaaa1111.jsonl') => `sessions/${day}/${name}`;
const read = (root, over = {}) => readCodexRateLimits(root, { profileId: 'p1', now: NOW, ...over });
const field = (reading, name) => reading.observations.find((entry) => entry.field === name);

test('the last token_count event gives both windows with their percent and reset, a plan and the last request\'s counts', (t) => {
  const root = home(t, { [rollout()]: [noise(), tokenCount({ minutesAgo: 20, primary: { used_percent: 1, window_minutes: 300, resets_at: epoch(100) } }), noise(), tokenCount({ minutesAgo: 1 }), noise()].join('\n') + '\n' });
  const reading = read(root);
  assert.equal(reading.ok, true);
  assert.equal(reading.observedAt, at(1));
  assert.equal(reading.planType, 'plus');
  assert.equal(field(reading, 'quota.five_hour.used_percent').value, 42.5);
  assert.equal(field(reading, 'quota.five_hour.resets_at').value, new Date(epoch(120) * 1000).toISOString());
  assert.equal(field(reading, 'quota.seven_day.used_percent').value, 10);
  for (const observation of reading.observations) { assert.equal(observation.confidence, 'actual'); assert.match(observation.source, /codex session log/); assert.equal(isFresh(observation, NOW), true); }
  assert.deepEqual(reading.usage, { input: 1200, cachedInput: 800, cacheWrite: 0, output: 300 });
});

test('windows are named by their length: a window of another length is not guessed at, and the slot does not decide', (t) => {
  const swapped = home(t, { [rollout()]: tokenCount({ primary: { used_percent: 5, window_minutes: 10080, resets_at: epoch(60) }, secondary: { used_percent: 6, window_minutes: 300, resets_at: epoch(60) } }) });
  const reading = read(swapped);
  assert.equal(field(reading, 'quota.five_hour.used_percent').value, 6);
  assert.equal(field(reading, 'quota.seven_day.used_percent').value, 5);
  const odd = home(t, { [rollout()]: tokenCount({ primary: { used_percent: 5, window_minutes: 60, resets_at: epoch(60) }, secondary: { used_percent: 6, window_minutes: 1440, resets_at: epoch(60) } }) });
  assert.deepEqual(read(odd), { ok: false, reason: 'codex-format-changed', observedAt: at(1), usage: { input: 1200, cachedInput: 800, cacheWrite: 0, output: 300 }, sessionKey: 'codex-2026-10-21T09-00-00-aaaa1111' });
});

test('a window that has reset, a percent out of range or of the wrong type, and a bad reset are unknown, never 0', (t) => {
  const expired = read(home(t, { [rollout()]: tokenCount({ primary: { used_percent: 99, window_minutes: 300, resets_at: epoch(-5) } }) }));
  assert.equal(field(expired, 'quota.five_hour.used_percent').confidence, 'unknown');
  assert.equal(field(expired, 'quota.five_hour.used_percent').reason, 'window-reset-passed');
  assert.equal(field(expired, 'quota.seven_day.used_percent').value, 10, 'the other window is unaffected');
  for (const used_percent of [-1, 101, Number.NaN, '40', null, undefined]) {
    const reading = read(home(t, { [rollout()]: tokenCount({ primary: { used_percent, window_minutes: 300, resets_at: epoch(60) } }) }));
    assert.notEqual(field(reading, 'quota.five_hour.used_percent').confidence, 'actual', String(used_percent));
    assert.equal(field(reading, 'quota.five_hour.used_percent').value, null);
  }
  for (const resets_at of ['soon', 0, -3, Number.POSITIVE_INFINITY, {}, null, undefined]) {
    const reading = read(home(t, { [rollout()]: tokenCount({ primary: { used_percent: 5, window_minutes: 300, resets_at } }) }));
    assert.equal(field(reading, 'quota.five_hour.used_percent').value, null, String(resets_at));
  }
});

test('a reading goes stale after the usual lifetime and never outlives its reset', (t) => {
  const reading = read(home(t, { [rollout()]: tokenCount({ minutesAgo: 1, primary: { used_percent: 50, window_minutes: 300, resets_at: epoch(3) } }) }));
  const five = field(reading, 'quota.five_hour.used_percent');
  assert.equal(isFresh(five, NOW), true);
  assert.equal(isFresh(five, new Date(NOW.getTime() + 4 * 60_000)), false, 'past the reset it is no longer a reading');
  const old = read(home(t, { [rollout()]: tokenCount({ minutesAgo: 90 }) }));
  assert.equal(isFresh(field(old, 'quota.five_hour.used_percent'), NOW), false, 'an hour and a half old is out of date, though it is the last thing the log said');
});

test('a time in the future, a missing or malformed time, and a missing rate_limits are unknown with their own reason', (t) => {
  assert.equal(read(home(t, { [rollout()]: tokenCount({ minutesAgo: -30 }) })).reason, 'timestamp-future');
  for (const timestamp of [undefined, 'yesterday', 12345, null]) {
    const line = JSON.parse(tokenCount()); if (timestamp === undefined) delete line.timestamp; else line.timestamp = timestamp;
    assert.equal(read(home(t, { [rollout()]: JSON.stringify(line) })).reason, 'timestamp-invalid', String(timestamp));
  }
  for (const rateLimits of [null, 'x', 5, []]) assert.equal(read(home(t, { [rollout()]: tokenCount({ rateLimits }) })).reason, 'rate-limits-absent', JSON.stringify(rateLimits));
});

test('without a sessions folder, without files, or without any token_count event the reading is unknown and says which', (t) => {
  assert.equal(read(home(t)).reason, 'no-sessions-folder');
  assert.equal(read(home(t, { 'sessions/2026/10/21/notes.txt': 'x' })).reason, 'no-session-files');
  assert.equal(read(home(t, { [rollout()]: noise() + '\n' })).reason, 'no-token-count');
  for (const bad of [undefined, null, '', 'relative/path', 5]) assert.equal(readCodexRateLimits(bad, { now: NOW }).reason, 'codex-home-invalid');
});

test('the newest file wins; an unusable newest file falls back to the next, up to a few files', (t) => {
  const older = tokenCount({ minutesAgo: 30, primary: { used_percent: 11, window_minutes: 300, resets_at: epoch(60) } });
  const newer = tokenCount({ minutesAgo: 2, primary: { used_percent: 22, window_minutes: 300, resets_at: epoch(60) } });
  const root = home(t, { [rollout('2026/10/20', 'rollout-2026-10-20T09-00-00-bbbb2222.jsonl')]: older, [rollout('2026/10/21', 'rollout-2026-10-21T08-00-00-cccc3333.jsonl')]: older, [rollout('2026/10/21', 'rollout-2026-10-21T09-30-00-dddd4444.jsonl')]: newer });
  assert.equal(field(read(root), 'quota.five_hour.used_percent').value, 22);
  const empty = home(t, { [rollout('2026/10/21', 'rollout-2026-10-21T09-30-00-dddd4444.jsonl')]: noise(), [rollout('2026/10/21', 'rollout-2026-10-21T08-00-00-cccc3333.jsonl')]: older });
  assert.equal(field(read(empty), 'quota.five_hour.used_percent').value, 11, 'a newer log with no token_count yet does not hide the previous one');
  const many = {};
  for (let index = 0; index < MAX_FILES_TRIED + 3; index += 1) many[rollout('2026/10/21', `rollout-2026-10-21T10-0${index}-00-x${index}.jsonl`)] = noise();
  many[rollout('2026/10/20', 'rollout-2026-10-20T09-00-00-old.jsonl')] = older;
  assert.equal(read(home(t, many)).reason, 'no-token-count', 'a bounded number of files is tried');
});

test('a huge file is read only from its end, never loaded whole', (t) => {
  const root = home(t, { [rollout()]: 'x'.repeat(10) });
  const file = path.join(root, rollout());
  const pad = noise('P'.repeat(900));
  const big = Array.from({ length: Math.ceil((MAX_TAIL_BYTES * 8) / pad.length) }, () => pad).join('\n');
  fs.writeFileSync(file, `${tokenCount({ minutesAgo: 400, primary: { used_percent: 1, window_minutes: 300, resets_at: epoch(60) } })}\n${big}\n${tokenCount({ minutesAgo: 1 })}\n`);
  const reads = [];
  const spy = { ...fs, readSync: (fd, buffer, offset, length, position) => { reads.push(length); return fs.readSync(fd, buffer, offset, length, position); }, constants: fs.constants };
  const reading = read(root, { fsImpl: spy });
  assert.equal(field(reading, 'quota.five_hour.used_percent').value, 42.5);
  assert.ok(reads.reduce((sum, length) => sum + length, 0) <= MAX_TAIL_BYTES, 'at most the tail limit was read');
  const old = home(t, {});
  const oldFile = path.join(old, rollout());
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, `${tokenCount({ minutesAgo: 1 })}\n${big}\n`);
  assert.equal(read(old).reason, 'no-token-count', 'an event further back than the tail is not reached');
});

test('a line longer than the line limit, and lines that are not JSON, are skipped without stopping the scan', (t) => {
  const huge = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', filler: 'F'.repeat(70 * 1024) } });
  const root = home(t, { [rollout()]: [tokenCount({ minutesAgo: 3 }), huge, '{"type": "event_msg", "payload": {"type": "token_count"', 'not json token_count', ''].join('\n') });
  const reading = read(root);
  assert.equal(reading.ok, true);
  assert.equal(reading.observedAt, at(3));
});

test('nothing but the fixed numbers and short codes survives: no prompt, no path, no other field', (t) => {
  const line = JSON.parse(tokenCount());
  line.payload.extra = 'SECRET-EXTRA'; line.payload.info.session_cwd = '/synthetic/project'; line.payload.rate_limits.primary.note = 'SECRET-NOTE'; line.payload.rate_limits.plan_type = 'plus';
  const root = home(t, { [rollout()]: `${noise('SECRET-PROMPT')}\n${JSON.stringify(line)}\n` });
  const reading = read(root);
  const text = JSON.stringify(reading);
  for (const secret of ['SECRET-EXTRA', '/synthetic/project', 'SECRET-NOTE', 'SECRET-PROMPT', root, 'balance', 'credits']) assert.equal(text.includes(secret), false, secret);
  const odd = JSON.parse(tokenCount()); odd.payload.rate_limits.plan_type = 'plus\nmalicious <script>';
  assert.equal(read(home(t, { [rollout()]: JSON.stringify(odd) })).planType, null, 'a plan that is not a short code is dropped');
});

test('only rollout files under sessions are ever opened: the credential file of the profile is not', { skip: !posix }, (t) => {
  const root = home(t, { [rollout()]: tokenCount(), 'auth.json': '{"tokens":{"access_token":"must-never-be-read"}}', 'config.toml': 'x', 'sessions/2026/10/21/auth.json': 'must-never-be-read', 'sessions/auth.json': 'must-never-be-read' });
  const opened = [];
  const spy = { ...fs, openSync: (file, ...rest) => { opened.push(file); return fs.openSync(file, ...rest); }, readFileSync: () => { throw new Error('whole-file reads are not used'); }, constants: fs.constants };
  assert.equal(read(root, { fsImpl: spy }).ok, true);
  assert.deepEqual(opened, [path.join(root, rollout())]);
  assert.equal(JSON.stringify(read(root)).includes('must-never-be-read'), false);
});

test('a link is never followed: not the sessions folder, not a date folder, not a log file', { skip: !posix }, (t) => {
  const outside = home(t, { [rollout()]: tokenCount({ primary: { used_percent: 77, window_minutes: 300, resets_at: epoch(60) } }) });
  const viaSessions = home(t);
  fs.symlinkSync(path.join(outside, 'sessions'), path.join(viaSessions, 'sessions'));
  assert.equal(read(viaSessions).reason, 'sessions-unsafe');
  const viaDay = home(t);
  fs.mkdirSync(path.join(viaDay, 'sessions/2026/10'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'sessions/2026/10/21'), path.join(viaDay, 'sessions/2026/10/21'));
  assert.equal(read(viaDay).reason, 'no-session-files');
  const viaFile = home(t);
  fs.mkdirSync(path.join(viaFile, 'sessions/2026/10/21'), { recursive: true });
  fs.symlinkSync(path.join(outside, rollout()), path.join(viaFile, rollout()));
  assert.equal(read(viaFile).reason, 'no-session-files');
  assert.equal(JSON.stringify([read(viaSessions), read(viaDay), read(viaFile)]).includes('77'), false);
});

test('the usage entry is the last request\'s counts, once per event, with cached input as cache read', (t) => {
  const reading = read(home(t, { [rollout()]: tokenCount() }));
  const entry = codexUsageEntry(reading, { accountProfileId: 'profile-a' });
  assert.deepEqual(entry, { at: at(1), sessionId: 'codex-2026-10-21T09-00-00-aaaa1111', provider: 'codex', accountProfileId: 'profile-a', model: null, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: null, measurement: 'actual', source: 'codex-session-log' });
  assert.deepEqual(codexUsageEntry(read(home(t, { [rollout()]: tokenCount() })), { accountProfileId: 'profile-a' }), entry, 'the same event gives the same entry, which the log keeps once');
  assert.equal(codexUsageEntry(read(home(t, { [rollout()]: tokenCount({ info: null }) })), { accountProfileId: 'p' }), null, 'no counts, no entry');
  assert.equal(codexUsageEntry(null, { accountProfileId: 'p' }), null);
  assert.equal(codexUsageEntry({ ok: false, reason: 'no-token-count' }, { accountProfileId: 'p' }), null);
});

test('a window is "already reset" by the time NOW, not by the time the event was written', (t) => {
  // The event was written 30 minutes ago and its window resets 10 minutes ago: it was still open when written, but is over now.
  const root = home(t, { [rollout()]: tokenCount({ minutesAgo: 30, primary: { used_percent: 90, window_minutes: 300, resets_at: epoch(-10) }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: epoch(60) } }) });
  const reading = read(root);
  assert.equal(reading.ok, true);
  const five = field(reading, 'quota.five_hour.used_percent');
  assert.equal(five.value, null, 'the 5-hour percent of a window that has since reset is not shown');
  assert.equal(five.reason, 'window-reset-passed');
  assert.equal(field(reading, 'quota.five_hour.resets_at').value, null);
  assert.equal(field(reading, 'quota.seven_day.used_percent').value, 10, 'the other window is untouched');
  // The same event read when its reset is still ahead is a reading.
  const earlier = read(root, { now: new Date(NOW.getTime() - 20 * 60_000) });
  assert.equal(field(earlier, 'quota.five_hour.used_percent').value, 90);
});

test('when the search runs out of room with no file found the reason is no-session-files, not an unreadable log', (t) => {
  const files = {};
  // More day folders than the search looks at, all empty.
  for (let day = 1; day <= 20; day += 1) files[`sessions/2026/10/${String(day).padStart(2, '0')}/.keep-not-a-rollout`] = '';
  const root = home(t, files);
  assert.deepEqual(read(root), { ok: false, reason: 'no-session-files' });
});

test('the newest entries are kept when a folder has more than the limit: names are sorted first, then cut', (t) => {
  const files = {};
  for (let index = 0; index < 1005; index += 1) files[`sessions/2026/10/21/rollout-2026-10-21T00-00-${String(index).padStart(4, '0')}-aaaa.jsonl`] = noise();
  const newest = 'rollout-2026-10-21T00-00-1004-aaaa.jsonl';
  files[`sessions/2026/10/21/${newest}`] = tokenCount({ minutesAgo: 1 });
  const root = home(t, files);
  const opened = [];
  const spy = { ...fs, openSync: (file, ...rest) => { opened.push(path.basename(file)); return fs.openSync(file, ...rest); } };
  const reading = readCodexRateLimits(root, { profileId: 'p1', now: NOW, fsImpl: spy });
  assert.equal(reading.ok, true, 'the newest file, which sorts last, is among those kept');
  assert.equal(opened[0], newest);
  // The listing order of the disk does not matter: a listing in the opposite order gives the same answer.
  const reversed = { ...fs, readdirSync: (dir, ...rest) => fs.readdirSync(dir, ...rest).reverse() };
  assert.equal(readCodexRateLimits(root, { profileId: 'p1', now: NOW, fsImpl: reversed }).ok, true);
});

test('a Codex session\'s observation change reads its account\'s log and keeps the counts, once', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/sessions/sessionCommands.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /view\.provider === 'codex' && typeof view\.accountProfileId === 'string' && view\.accountProfileId !== 'unassigned'\) await recordCodexSessionReading\(view\.accountProfileId, \(\) => manager\.list\(\)\);/);
  const gate = fs.readFileSync(path.join(__dirname, '../../src/accounts/quotaGateUi.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = gate.slice(gate.indexOf('export async function recordCodexSessionReading'), gate.indexOf('export interface QuotaDetail'));
  assert.match(body, /own\.profile\.provider !== 'codex'\) return;/);
  assert.match(body, /new UsageLog\(accounts\.store\)\.append\(entry, now\)/);
  assert.match(body, /catch \{ \/\* a reading that cannot be kept never disturbs the session \*\/ \}/);
});
