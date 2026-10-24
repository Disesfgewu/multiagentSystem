'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { quotaSummary, identitySummary, accountsOverview, duplicateLine, NEXT_STEPS } = require('../../src/accounts/account-row');
const { AccountCheckStore, COLLECTION, storable } = require('../../src/accounts/account-checks');
const { displayFromStatus } = require('../../src/accounts/identity-check');
const { PrivateStore } = require('../../src/storage/private-store');

const NOW = new Date('2026-10-23T10:00:00Z');
const EMAIL = 'someone@example.test';
const signedIn = (over = {}) => ({ ok: true, state: 'checked', reason: 'checked', checkedAt: '2026-10-23T09:58:00.000Z', source: 'claude auth status --json', identity: { provider: 'claude', loggedIn: true, authMethod: 'claude.ai', subject: { value: 'a'.repeat(32), confidence: 'actual' }, plan: { value: 'max', confidence: 'actual' }, anomalies: [] }, ...over });

test('the usage part: current numbers with their reset, an out-of-date one marked, and without a number why and what to do (#352)', () => {
  assert.deepEqual(quotaSummary({ ok: true, windows: [{ window: 'five_hour', usedPercent: 32, fresh: true, resetsAt: '2026-10-23T12:00:00Z' }, { window: 'seven_day', usedPercent: 10, fresh: true }], unknownReason: null }, NOW), { text: '5h 32% (resets in 2h) · 7d 10%', attention: false });
  for (const [reason, words] of Object.entries(NEXT_STEPS)) assert.equal(quotaSummary({ ok: true, windows: [], unknownReason: reason }, NOW).text, `usage unknown: ${words}`, reason);
  assert.match(quotaSummary({ ok: true, windows: [], unknownReason: 'bridge-no-data' }, NOW).text, /no agent has run on this account yet: start one and its usage appears/);
  assert.equal(quotaSummary({ ok: true, windows: [], unknownReason: 'bridge-not-enabled' }, NOW).attention, true, 'a status line that is not set up needs the person');
  const stale = quotaSummary({ ok: true, windows: [{ window: 'five_hour', usedPercent: 80, fresh: false, observedAt: '2026-10-23T03:00:00Z' }], unknownReason: 'reading-expired' }, NOW);
  assert.equal(stale.text, 'usage unknown: last reading is out of date: it refreshes while an agent runs on this account · 5h 80% (out of date, read 7 h ago) · 7d: not reported in the last reading');
  assert.equal(quotaSummary({ ok: true, windows: [], unknownReason: 'something-new' }, NOW).text, 'usage unknown: no usage reading for this account yet');
  for (const detail of [null, { ok: false }, { ok: true, windows: 'x' }]) assert.deepEqual(quotaSummary(detail, NOW), { text: 'usage could not be read', attention: true });
  assert.ok(!quotaSummary({ ok: true, windows: [], unknownReason: 'bridge-no-data' }, NOW).text.includes('unknown.'), 'never only "unknown"');
});

test('5h and 7d always have a place: a current 5h never hides a missing, unusable or out-of-date 7d (#352)', () => {
  const five = { window: 'five_hour', usedPercent: 32, fresh: true, resetsAt: '2026-10-23T12:00:00Z' };
  const at = (seven, extra = []) => quotaSummary({ ok: true, windows: [five, ...(seven ? [seven] : []), ...extra], unknownReason: null }, NOW);
  assert.deepEqual(at({ window: 'seven_day', usedPercent: 50, fresh: false, observedAt: '2026-10-23T07:00:00Z' }), { text: '5h 32% (resets in 2h) · 7d 50% (out of date, read 3 h ago)', attention: false });
  assert.equal(at(null).text, '5h 32% (resets in 2h) · 7d: not reported in the last reading');
  assert.equal(at({ window: 'seven_day', usedPercent: null, fresh: false }).text, '5h 32% (resets in 2h) · 7d: the last reading has no usable number');
  assert.equal(at({ window: 'seven_day', usedPercent: 10, fresh: true }, [{ window: 'seven_day_sonnet', usedPercent: 12, fresh: true }, { window: 'seven_day_opus', usedPercent: 71, fresh: true }, { window: 'seven_day_new_model', usedPercent: 3, fresh: true }]).text,
    '5h 32% (resets in 2h) · 7d 10% · 7d New Model 3% · 7d Opus 71% · 7d Sonnet 12%', 'per-model weekly windows follow, each named');
  assert.equal(quotaSummary({ ok: true, windows: [{ window: 'seven_day', usedPercent: 10, fresh: true }], unknownReason: null }, NOW).text, '5h: not reported in the last reading · 7d 10%');
});

test('which account it is: the e-mail and organization when this window has them, the plan, sign-in and when it was checked (#352)', () => {
  const shown = identitySummary({ check: signedIn(), display: { email: EMAIL, organization: 'Acme' }, now: NOW });
  assert.equal(shown.text, `${EMAIL} (Acme) · Max plan · signed in · checked 2 min ago`);
  assert.deepEqual([shown.signedIn, shown.attention], [true, false]);
  assert.ok(shown.lines.includes(`Account: ${EMAIL} · Organization: Acme`));
  const restored = identitySummary({ check: { ...signedIn(), restored: true }, now: NOW });
  assert.equal(restored.text, 'account: shown after the next check · Max plan · signed in · checked 2 min ago (before this window opened)');
  assert.match(identitySummary({ check: signedIn(), now: NOW, checking: true }).text, /^account: checking…/);
  assert.equal(identitySummary({ check: signedIn({ identity: { ...signedIn().identity, plan: { value: null } } }), display: { email: EMAIL }, now: NOW }).text, `${EMAIL} · plan unknown · signed in · checked 2 min ago`);
  const out = identitySummary({ check: signedIn({ identity: { ...signedIn().identity, loggedIn: false } }), now: NOW });
  assert.deepEqual([out.text, out.signedIn, out.attention], ['not signed in · checked 2 min ago', false, true]);
  assert.match(out.lines.join('\n'), /Next: open the login terminal/);
  const failed = identitySummary({ check: { ok: false, state: 'unknown', reason: 'cli-not-found', checkedAt: '2026-10-23T09:58:00.000Z', identity: null }, now: NOW });
  assert.deepEqual([failed.text, failed.signedIn, failed.attention], ['sign-in unknown · checked 2 min ago', null, true]);
  assert.match(failed.lines.join('\n'), /could not be started[\s\S]*Next: Check that the CLI is installed/);
  assert.deepEqual([identitySummary({}).text, identitySummary({ checking: true }).text], ['sign-in not checked yet', 'checking sign-in…']);
  assert.equal(accountsOverview([identitySummary({}), identitySummary({ check: signedIn(), display: { email: EMAIL }, now: NOW })]), '2 accounts · 1 signed in · 1 needs attention', 'an account not checked yet needs attention');
  assert.equal(identitySummary({ checking: true }).attention, false, 'one being checked does not, yet');
});

test('the line above all accounts, and the words for two folders signed in to one real account (#352)', () => {
  assert.equal(accountsOverview([{ signedIn: true, attention: false }, { signedIn: true, attention: true }, { signedIn: null, attention: true }]), '3 accounts · 2 signed in · 2 need attention');
  assert.equal(accountsOverview([{ signedIn: true, attention: false }]), '1 account · 1 signed in · nothing needs attention');
  assert.equal(accountsOverview([{ signedIn: false, attention: true }]), '1 account · 0 signed in · 1 needs attention');
  assert.match(duplicateLine(['Work', 'Home']), /^Same account as “Work”, “Home”: both folders are signed in to one real account[\s\S]*Sign In to Account[\s\S]*remove it\.$/);
  assert.equal(duplicateLine([]), null);
});

test('the CLI\'s e-mail and organization are read only as plain, short, single-line text', () => {
  assert.deepEqual(displayFromStatus({ email: EMAIL, orgName: 'Acme Inc' }), { email: EMAIL, organization: 'Acme Inc' });
  for (const status of [{ email: 'no-at-sign' }, { email: `a\n${EMAIL}` }, { email: 5 }, { email: 'a'.repeat(300) + '@x.test' }, {}]) assert.equal(displayFromStatus(status).email, null, JSON.stringify(status).slice(0, 40));
  for (const orgName of ['', 'x'.repeat(101), 'a‮b', 7]) assert.equal(displayFromStatus({ email: EMAIL, orgName }).organization, null, String(orgName));
});

test('a saved check keeps the reduced identity and never an e-mail address; a record that cannot be read is left out (#352)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-checks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PrivateStore({ dir, repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'mas-checks-repo-')), collections: [COLLECTION] });
  const checks = new AccountCheckStore(store);
  // Whatever the caller passes, the display part is dropped.
  assert.deepEqual(checks.save('acct-1', { ...signedIn(), display: { email: EMAIL, organization: 'Acme' } }), { ok: true });
  const onDisk = fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, String(name))).filter((file) => fs.statSync(file).isFile()).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(onDisk.includes(EMAIL), false, 'the e-mail address is nowhere in the private store\'s files');
  assert.equal(onDisk.includes('Acme'), false, 'nor the organization');
  const loaded = new AccountCheckStore(store).load(['acct-1', 'acct-2', 'bad id']);
  assert.deepEqual([...loaded.keys()], ['acct-1']);
  assert.equal(loaded.get('acct-1').restored, true);
  assert.equal(loaded.get('acct-1').identity.plan.value, 'max');
  assert.equal(loaded.get('acct-1').display, undefined);
  // An identity that would carry an e-mail address (its shape changed) is refused rather than written.
  assert.equal(checks.save('acct-3', signedIn({ identity: { ...signedIn().identity, apiProvider: EMAIL } })).reason, 'invalid-result');
  for (const bad of [null, { state: 'other' }, { ...signedIn(), checkedAt: 'soon' }, { ...signedIn(), reason: 'Bad Reason' }, { ...signedIn(), identity: { loggedIn: 'yes' } }]) assert.equal(storable(bad), null, JSON.stringify(bad).slice(0, 50));
  assert.equal(checks.save('../x', signedIn()).reason, 'invalid-profile');
  // A stored record that does not validate is not shown as a check.
  assert.ok(store.transact((tx) => { tx.put(COLLECTION, 'acct-4', { schemaVersion: 1, state: 'checked', reason: 'checked', checkedAt: 'never', source: null, identity: null, ok: true }); return true; }).ok);
  assert.equal(new AccountCheckStore(store).load(['acct-4']).size, 0);
});

const source = fs.readFileSync(path.join(__dirname, '../../src/accounts/accountCommands.ts'), 'utf8');

test('the e-mail address goes only to the screen: the display map is read for the row, the details, the side bar count and the Workbench card, and never stored or logged (#352, #357)', () => {
  const uses = [...source.matchAll(/checkDisplays\.(\w+)\(/g)].map((match) => match[1]);
  assert.deepEqual(uses.sort(), ['delete', 'get', 'get', 'get', 'get', 'set'], uses.join(','));
  // The side bar count passes it to identitySummary only to know signed in or not; the Workbench card is the one other reader.
  assert.match(source, /export function accountEmail\(profileId: string\): string \| null \{\n {2}return checkDisplays\.get\(profileId\)\?\.email \?\? null;\n\}/);
  const srcRoot = path.join(__dirname, '../../src');
  const readers = fs.readdirSync(srcRoot, { recursive: true }).filter((name) => /\.(ts|js)$/.test(name)).filter((name) => /\baccountEmail\(/.test(fs.readFileSync(path.join(srcRoot, name), 'utf8'))).map((name) => name.replace(/\\/g, '/')).sort();
  assert.deepEqual(readers, ['accounts/accountCommands.ts', 'commandCenter/commandCenter.ts'], 'only the Workbench cards read it');
  assert.match(source, /const \{ display, \.\.\.result \} = outcome;[\s\S]*new AccountCheckStore\(accounts\.store\)\.save\(profile\.id, result\)/, 'what is saved is the result without the display part');
  assert.match(source, /const \{ display: _display, \.\.\.outcome \} = await checkAccountIdentity/, 'the launch probe drops it too');
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*display/i);
});
