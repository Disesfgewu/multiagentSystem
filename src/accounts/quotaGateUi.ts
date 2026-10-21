import * as vscode from 'vscode';
import { accountService, SessionUse } from './accountRuntime';
import { quotaObservations, quotaUnknownReason, registerProfileForQuota, codexQuotaReading } from './claudeStatusLine';
import { privateStorage } from '../storage/storageCommands';

export { quotaObservations, registerProfileForQuota };

const { UsageLog } = require('./usage-log') as { UsageLog: new (store: unknown) => { append(entry: unknown, now?: Date): { ok: boolean } } };
const { codexUsageEntry } = require('./codex-rate-limits') as { codexUsageEntry(reading: unknown, options: { accountProfileId: string }): unknown };

const { summarizeQuota } = require('./quota-policy') as { summarizeQuota(observations: unknown[], now: Date): Array<{ window: string; usedPercent: number | null; source: string | null; observedAt: string | null; confidence: string; fresh: boolean; gateEligible: boolean; resetsAt: string | null }> };
const { loadPolicy, savePolicy } = require('./quota-policy') as {
  loadPolicy(store: unknown, id: string): { ok: boolean; policy?: Record<string, unknown>; stored?: boolean };
  savePolicy(store: unknown, id: string, input: unknown): { ok: boolean; reason?: string; problems?: string[] };
};
const { gateLaunch, describePolicy, describeQuota, describeCurrentState, policyFromInput, wordsFor } = require('./quota-gate') as {
  gateLaunch(input: Record<string, unknown>): { action: 'allow' | 'warn' | 'confirm' | 'block'; allowed: boolean; overridable: boolean; lines: string[]; note: string | null; reasons: Array<{ code: string }> };
  describePolicy(read: unknown): string;
  describeQuota(observations: unknown[], now: Date, unknownReason?: string | null): string[];
  describeCurrentState(decision: { action: string; lines: string[] }): string;
  policyFromInput(input: Record<string, unknown>): { ok: boolean; policy?: Record<string, unknown>; problems: string[] };
  wordsFor(reason: { code: string }): string;
};
const { runningSlots, recoverOrphanedSlots, reserveSlot, renewSlot, releaseSlot, RENEW_MS } = require('./quota-reservations') as {
  runningSlots(store: unknown, accountKey: string, now?: Date, options?: { linkedAccountKeys?: string[] }): { ok: boolean; running?: number; orphaned?: number; reason?: string };
  recoverOrphanedSlots(store: unknown, accountKey: string, now?: Date, options?: { linkedAccountKeys?: string[] }): { ok: boolean; recovered?: number; reason?: string };
  reserveSlot(input: Record<string, unknown>): { ok: boolean; reason?: string; decision?: { allowed: boolean; reasons: Array<{ code: string }>; reservation?: { accountKey: string; id: string } } };
  renewSlot(store: unknown, reservation: { accountKey: string; id: string }, now?: Date, leaseMs?: number, options?: { reacquire?: boolean }): { ok: boolean; renewed?: boolean; reacquired?: boolean };
  releaseSlot(store: unknown, reservation: { accountKey: string; id: string }, now?: Date): { ok: boolean; released?: boolean };
  RENEW_MS: number;
};
const {
  recordVerifiedIdentity,
  resolveGroup,
  assessLaunchIdentity,
  groupReadings,
  readingsTrust,
  trustedReadings,
  coordinatePolicies
} = require('./identity-registry') as {
  recordVerifiedIdentity(store: unknown, profileId: string, identity: unknown, now?: Date): { ok: boolean; recorded?: boolean; changed?: boolean; reason?: string };
  resolveGroup(store: unknown, listProfiles: () => { ok: boolean; profiles?: any[] }, profileId: string): { ok: boolean; ids?: string[]; current?: string[]; known?: boolean; profiles?: any[]; fingerprint?: string; reason?: string };
  assessLaunchIdentity(store: unknown, profileId: string, outcome: unknown, now?: Date): { ok: boolean; unverified?: boolean; code?: string };
  readingsTrust(store: unknown, profileId: string): { ok: boolean; trusted: boolean; since: number | null };
  trustedReadings(readings: any[], trust: { ok: boolean; trusted: boolean; since: number | null }): any[];
  groupReadings(ownReadings: any[], currentIds: string[], readingsById: Map<string, any[]>, now?: Date): any[];
  coordinatePolicies(policyReads: any[]): { ok: boolean; stored?: boolean; policy?: Record<string, unknown> };
};

export { recordVerifiedIdentity };

/**
 * Asks the sign-in CLI who is signed in on a profile right now. Set by the account commands (which own
 * running the CLI); until then a launch cannot compare and relies on the saved groups alone.
 */
export type IdentityProbe = (profileId: string) => Promise<unknown>;
let identityProbe: IdentityProbe | undefined;
export function setIdentityProbe(probe: IdentityProbe | undefined): void { identityProbe = probe; }

interface GroupRead { ok: boolean; ids: string[]; current: string[]; known: boolean; profiles: any[]; fingerprint: string }
/** The other profiles that share this profile's verified provider account, from the shared private store. */
function groupOf(accounts: { store: unknown; service: { list(): { ok: boolean; profiles?: Array<{ id: string }> } } }, profileId: string): GroupRead {
  const found = resolveGroup(accounts.store, () => accounts.service.list(), profileId);
  return found.ok ? { ok: true, ids: found.ids ?? [], current: found.current ?? [], known: found.known === true, profiles: found.profiles ?? [], fingerprint: found.fingerprint ?? '' } : { ok: false, ids: [], current: [], known: false, profiles: [], fingerprint: '' };
}

interface GroupState {
  ok: boolean;
  /** Why it could not be read, in the person's words. */
  message?: string;
  ids: string[];
  /** What the group and the trust of its profiles' readings looked like when this was read; the reservation checks it again. */
  fingerprint: string;
  policyRead: { ok: boolean; stored?: boolean; policy?: Record<string, unknown> };
  observations: any[];
  /** Why this profile itself has no usable usage number, when that can be stated. */
  unknownReason?: string | null;
}

type AccountsOk = { store: unknown; service: { list(): { ok: boolean; profiles?: any[] }; get(id: string): { ok: boolean; profile?: any } } };

/**
 * Everything a decision needs about one profile and the other profiles of its real account: who they are
 * (from the shared private store, so every window and a restarted one agree), the limits coordinated over
 * all of them, and the usage readings with a valid actual one never replaced by a newer weaker one.
 */
function loadGroupState(accounts: AccountsOk, profileId: string, now: Date): GroupState {
  const failed = (message: string): GroupState => ({ ok: false, message, ids: [], fingerprint: '', policyRead: { ok: false }, observations: [] });
  const group = groupOf(accounts as any, profileId);
  if (!group.ok) return failed('Which profiles share this account could not be established safely, so no new agent was started. Use Setup Diagnostics to check Private Storage.');
  const all = group.profiles;
  const own = accounts.service.get(profileId);
  const ownProfile = own.ok ? own.profile : undefined;
  if (ownProfile) registerProfileForQuota(ownProfile);
  const mine = loadPolicy(accounts.store, profileId);
  const others = group.ids.map((id) => loadPolicy(accounts.store, id));
  const policyRead = group.ids.length > 0 ? coordinatePolicies([mine, ...others]) : mine;
  // Every linked profile is registered and counted for leases and limits; only those signed in as the same
  // account right now contribute usage readings.
  const readingsById = new Map<string, any[]>();
  for (const id of group.ids) {
    const other = all.find((candidate: any) => candidate.id === id);
    if (other) registerProfileForQuota(other);
    if (group.current.includes(id)) readingsById.set(id, trustedReadings(quotaObservations(id, other), readingsTrust(accounts.store, id)));
  }
  // Readings carry no account: after a profile changed account, only readings that can be shown to follow the change are used.
  const ownReadings = trustedReadings(quotaObservations(profileId, ownProfile), readingsTrust(accounts.store, profileId));
  const observations = groupReadings(ownReadings, group.current, readingsById, now);
  return { ok: true, ids: group.ids, fingerprint: group.fingerprint, policyRead, observations, unknownReason: quotaUnknownReason(profileId, ownProfile, now) };
}

export type GateOutcome = { ok: true; release: () => Promise<void> } | { ok: false; code: string; message: string };

function reservationFailure(reason?: string): GateOutcome {
  const message = reason === 'policy-changed'
    ? 'Account limits changed while this launch was being checked. Try again to review the current limits.'
    : reason === 'group-changed'
      ? 'Which profiles share this account changed while this launch was being checked, so no new agent was started. Try again.'
      : 'Shared running-session limits could not be read safely, so no new agent was started.';
  return { ok: false, code: 'quota-gate', message };
}

// Releases that could not be written. A lease taken on this computer keeps counting until it is
// released or recovered, so a release that never lands
// would hold the slot: it is retried until it does.
const pendingReleases = new Map<string, { accountKey: string; id: string }>();
let pendingTimer: ReturnType<typeof setInterval> | undefined;

async function flushPendingReleases(): Promise<void> {
  if (pendingReleases.size === 0) return;
  const opened = await privateStorage()?.use();
  if (!opened?.ok) return;
  for (const [id, reservation] of [...pendingReleases]) {
    if (releaseSlot(opened.store, reservation, new Date()).ok) pendingReleases.delete(id);
  }
  if (pendingReleases.size === 0 && pendingTimer) { clearInterval(pendingTimer); pendingTimer = undefined; }
}

function releaseLater(reservation: { accountKey: string; id: string }): void {
  pendingReleases.set(reservation.id, reservation);
  if (!pendingTimer) {
    pendingTimer = setInterval(() => void flushPendingReleases(), RENEW_MS);
    pendingTimer.unref?.();
  }
}

function holdReservation(reservation: { accountKey: string; id: string }): GateOutcome {
  let released = false;
  let renewing = false;
  let warnedRefresh = false;
  let warnedReacquired = false;
  const renew = async (): Promise<void> => {
    if (released || renewing) return;
    renewing = true;
    try {
      const opened = await privateStorage()?.use();
      // Released while storage was opening: renewing now would put a stopped session's slot back.
      if (released) return;
      const result = opened?.ok ? renewSlot(opened.store, reservation, new Date(), undefined, { reacquire: true }) : { ok: false };
      if (result.ok && result.reacquired === true && !warnedReacquired) {
        warnedReacquired = true;
        void vscode.window.showWarningMessage('The shared running-session reservation of an agent that is still running had been lost. It was registered again, so this account may be above its running-agent limit until a session stops.');
      } else if ((!result.ok || result.renewed !== true) && !warnedRefresh) {
        warnedRefresh = true;
        void vscode.window.showWarningMessage('The shared running-session reservation could not be refreshed. It still counts while this window is open; new launches fail closed while storage is unavailable. Check Private Storage diagnostics.');
      }
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => void renew(), RENEW_MS);
  timer.unref?.();
  return {
    ok: true,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      const opened = await privateStorage()?.use();
      const result = opened?.ok ? releaseSlot(opened.store, reservation, new Date()) : { ok: false };
      if (!result.ok) releaseLater(reservation);
    }
  };
}

/**
 * Applies the account's limits before a new agent starts on it. An account with no limits is never held
 * back, but its active sessions are tracked so later limits count them. Interactive callers can confirm
 * or (for usage limits) override; callers that cannot ask are refused whenever the limits say to ask or
 * to stop. On success, the caller MUST call the returned `release()` once, exactly when the session this
 * launch produced stops or its terminal closes; forgetting to release leaks a slot permanently.
 */
export async function gateAccountLaunch(accountProfileId: string, interactive: boolean, sessions: () => SessionUse[]): Promise<GateOutcome> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return { ok: false, code: 'quota-gate', message: 'Account limits could not be checked because private storage is not ready, so no new agent was started.' };
  await flushPendingReleases();

  // A profile that was verified before is asked again who is signed in right now: the check the person did
  // earlier says nothing about what happened since. A different account (or a sign-out) stops the launch;
  // an answer that cannot tell leaves the saved groups in force.
  if (identityProbe && groupOf(accounts as any, accountProfileId).known) {
    let outcome: unknown;
    try { outcome = await identityProbe(accountProfileId); } catch { outcome = null; }
    const assessed = assessLaunchIdentity(accounts.store, accountProfileId, outcome, new Date());
    if (!assessed.ok) {
      return assessed.code === 'identity-changed'
        ? { ok: false, code: 'identity-changed', message: 'The sign-in on this account is not the one that was verified before. Check the sign-in again before starting new agents.' }
        : { ok: false, code: 'quota-gate', message: 'Which account is signed in could not be established safely, so no new agent was started.' };
    }
  }

  const now = new Date();
  const state = loadGroupState(accounts as any, accountProfileId, now);
  if (!state.ok) return { ok: false, code: 'quota-gate', message: state.message ?? 'The account limits could not be read, so no new agent was started.' };
  const { policyRead, observations, ids: duplicateIds } = state;
  if (!policyRead.ok) return { ok: false, code: 'quota-gate', message: 'The saved account limits could not be read, so no new agent was started.' };
  const commit = async (approval?: 'confirm' | 'override'): Promise<GateOutcome> => {
    // Recheck after every await/dialog, then decide and reserve synchronously from fresh inputs.
    const latestAccounts = await accountService(sessions);
    if (!latestAccounts.ok) return { ok: false, code: 'quota-gate', message: 'Account limits could not be read again, so no new agent was started.' };
    const latestState = loadGroupState(latestAccounts as any, accountProfileId, new Date());
    if (!latestState.ok) return { ok: false, code: 'quota-gate', message: latestState.message ?? 'The saved account limits could not be read, so no new agent was started.' };
    const latest = latestState.policyRead;
    if (!latest.ok) return { ok: false, code: 'quota-gate', message: 'The saved account limits could not be read, so no new agent was started.' };
    if (latest.stored !== policyRead.stored || JSON.stringify(latest.policy) !== JSON.stringify(policyRead.policy) ||
        JSON.stringify(latestState.ids) !== JSON.stringify(duplicateIds)) {
      return { ok: false, code: 'quota-gate', message: 'Account limits changed while this launch was being checked. Try again to review the current limits.' };
    }

    const reserved = reserveSlot({
      store: latestAccounts.store,
      accountKey: accountProfileId,
      linkedAccountKeys: latestState.ids,
      expectedGroupFingerprint: latestState.fingerprint,
      expectedPolicyRead: latest,
      observations: latestState.observations,
      now: new Date(),
      approval
    });
    if (!reserved.ok || !reserved.decision) return reservationFailure(reserved.reason);
    if (!reserved.decision.allowed || !reserved.decision.reservation) {
      return { ok: false, code: 'quota-gate', message: reserved.decision.reasons.map(wordsFor).join(' ') };
    }
    return holdReservation(reserved.decision.reservation);
  };
  if (policyRead.stored !== true) return commit();
  // The running count that decides what to SHOW is a plain read, for responsive dialog wording; the
  // decision that actually GRANTS access is made again, atomically, in commit() above, so a request
  // that waited on a confirmation dialog cannot act on a running count that a concurrent request has
  // since made stale.
  const slots = runningSlots(accounts.store, accountProfileId, now, { linkedAccountKeys: duplicateIds });
  if (!slots.ok || !Number.isInteger(slots.running)) return reservationFailure(slots.reason);
  const running = slots.running as number;
  const first = gateLaunch({ policyRead, observations, now, running });
  if (first.action === 'allow') return commit();
  const text = [...first.lines, ...(first.note ? ['', first.note] : [])].join('\n');
  if (first.action === 'warn') {
    void vscode.window.showWarningMessage(`Account limits: ${first.lines[0] ?? 'a warning level was reached'}`);
    return commit();
  }
  // `interactive: false` here can only refuse (never override), so it fails closed; the commands that
  // reach this already force interactive outside test mode (src/shared/testMode.ts).
  if (!interactive || !first.overridable) return { ok: false, code: 'quota-gate', message: first.lines[0] ?? 'The account\'s limits stopped this agent.' };
  const confirmOnly = first.action === 'confirm';
  const buttons = first.overridable ? [confirmOnly ? 'Start Anyway' : 'Override and Start'] : [];
  const title = first.action === 'block' ? 'Account limits are holding back new agents.' : 'Account limits ask you to confirm.';
  const answer = await vscode.window.showWarningMessage(title, { modal: true, detail: text }, ...buttons);
  if (answer !== (confirmOnly ? 'Start Anyway' : 'Override and Start')) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
  return commit(confirmOnly ? 'confirm' : 'override');
}

export interface CurrentGate {
  action: 'allow' | 'warn' | 'confirm' | 'block';
  line: string;
  reason?: string;
}

/** What starting a new agent on this account would do right now: `null` when no policy is stored (so
 *  nothing is held back), or the plain action a real launch's gate would take at this instant. Reads
 *  the same dispatcher a real launch commits to, so this can never show a result a real launch
 *  couldn't reach; it only reports and never itself reserves a slot. */
export async function currentGateState(accountProfileId: string, sessions: () => SessionUse[]): Promise<CurrentGate | null> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return null;
  const now = new Date();
  const state = loadGroupState(accounts as any, accountProfileId, now);
  if (!state.ok) {
    return { action: 'block', line: 'Right now: a new agent would be held back. Which profiles share this account could not be established safely. Use Setup Diagnostics to check Private Storage.', reason: 'Which profiles share this account could not be established safely.' };
  }
  const { policyRead, observations, ids: duplicateIds } = state;
  if (!policyRead.ok || policyRead.stored !== true) return null;
  const slots = runningSlots(accounts.store, accountProfileId, now, { linkedAccountKeys: duplicateIds });
  if (!slots.ok || !Number.isInteger(slots.running)) {
    return { action: 'block', line: 'Right now: a new agent would be held back. Shared running-session limits could not be read safely. Use Setup Diagnostics to check Private Storage.', reason: 'Shared running-session limits could not be read safely.' };
  }
  const running = slots.running as number;
  const decision = gateLaunch({ policyRead, observations, now, running });
  return { action: decision.action, line: describeCurrentState(decision), reason: decision.lines[0] };
}

/** Lines for the account details: the limits, what is known about usage, and whether a new agent on
 *  this account would actually be allowed to start right now. */
export async function limitLines(accountProfileId: string, sessions: () => SessionUse[]): Promise<string[]> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return ['Limits: could not be read.'];
  const now = new Date();
  const state = loadGroupState(accounts as any, accountProfileId, now);
  if (!state.ok) return ['Limits: which profiles share this account could not be established safely, so new agents are held back.'];
  const { policyRead, observations, ids: duplicateIds } = state;
  const lines = [describePolicy(policyRead), ...describeQuota(observations, now, state.unknownReason)];
  if (duplicateIds.length > 0) {
    lines.push(`Duplicate account: shares limits and quota with ${duplicateIds.join(', ')}.`);
  }
  lines.push(...codexExtras(accounts as any, accountProfileId, now));
  const current = await currentGateState(accountProfileId, sessions);
  if (current) lines.push(current.line);
  return lines;
}

/**
 * For a Codex account: the plan its own session log reports, and the last request's token counts kept in the usage log (issue
 * #302, #294). Best effort and read-only apart from that append: nothing here can fail a launch or change a limit, and the same
 * event is kept only once.
 */
function codexExtras(accounts: AccountsOk, accountProfileId: string, now: Date): string[] {
  try {
    const own = accounts.service.get(accountProfileId);
    if (!own.ok || !own.profile || own.profile.provider !== 'codex') return [];
    const read = codexQuotaReading(accountProfileId, own.profile.configDir, now);
    const entry = codexUsageEntry(read.reading, { accountProfileId });
    if (entry) new UsageLog(accounts.store).append(entry, now);
    return read.planType ? [`Plan: ${read.planType} (reported by the Codex session log).`] : [];
  } catch {
    return [];
  }
}

export interface QuotaDetail {
  ok: boolean;
  windows: ReturnType<typeof summarizeQuota>;
  /** Why this account has no current usage number, as a code the wording table knows, or null. */
  unknownReason: string | null;
  policy: string;
  gate: 'allow' | 'warn' | 'confirm' | 'block' | null;
  gateReason: string | null;
  plan: string | null;
}

/**
 * The same facts `limitLines` words, as values (issue #304): each usage window with its percent, reset time, source and read time, why
 * there is no current number, the limits the person set and what a new agent would meet right now. Read-only; nothing here starts
 * anything or changes a limit. A part that cannot be read is unknown, never empty or zero.
 */
export async function quotaDetail(accountProfileId: string, sessions: () => SessionUse[]): Promise<QuotaDetail> {
  const unknownDetail: QuotaDetail = { ok: false, windows: [], unknownReason: null, policy: 'Limits: could not be read.', gate: null, gateReason: null, plan: null };
  const accounts = await accountService(sessions);
  if (!accounts.ok) return unknownDetail;
  const now = new Date();
  const state = loadGroupState(accounts as any, accountProfileId, now);
  if (!state.ok) return { ...unknownDetail, policy: 'Limits: which profiles share this account could not be established safely.' };
  const current = await currentGateState(accountProfileId, sessions);
  let plan: string | null = null;
  try {
    const own = (accounts as any).service.get(accountProfileId);
    if (own.ok && own.profile?.provider === 'codex') plan = codexQuotaReading(accountProfileId, own.profile.configDir, now).planType;
  } catch { plan = null; }
  return {
    ok: true,
    windows: summarizeQuota(state.observations, now),
    unknownReason: state.unknownReason ?? null,
    policy: describePolicy(state.policyRead),
    gate: current ? current.action : null,
    gateReason: current?.reason ?? null,
    plan
  };
}

/** Lets the person set the limits for one account. `input` is used instead of asking when given (tests). */
export async function editLimits(accountProfileId: string, label: string, sessions: () => SessionUse[], input?: { warn?: string; block?: string; max?: string; unknownQuota?: string }): Promise<{ ok: boolean; reason?: string; problems?: string[]; cancelled?: boolean }> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return { ok: false, reason: 'storage-unavailable' };
  let values = input;
  if (!values) {
    const current = loadPolicy(accounts.store, accountProfileId);
    const policy = current.ok && current.stored ? current.policy ?? {} : {};
    const ask = (prompt: string, value: unknown): Thenable<string | undefined> => vscode.window.showInputBox({ prompt, value: value === undefined ? '' : String(value), placeHolder: 'leave empty for none', ignoreFocusOut: true });
    const warn = await ask(`“${label}”: warn when usage reaches this percent (0–100)`, policy.warnAtPercent);
    if (warn === undefined) return { ok: false, cancelled: true };
    const block = await ask(`“${label}”: stop starting new agents at this percent (0–100)`, policy.blockAtPercent);
    if (block === undefined) return { ok: false, cancelled: true };
    const max = await ask(`“${label}”: at most this many agents running at once (1–64)`, policy.maxConcurrent);
    if (max === undefined) return { ok: false, cancelled: true };
    const unknown = await vscode.window.showQuickPick([
      { label: 'Ask me first', detail: 'When usage is unknown, a new agent needs your confirmation. (Recommended)', value: 'require-confirmation' },
      { label: 'Do not start new agents', detail: 'When usage is unknown, new agents are held back until you override.', value: 'block' }
    ], { placeHolder: 'What should happen when this account\'s usage is unknown?', ignoreFocusOut: true });
    if (!unknown) return { ok: false, cancelled: true };
    values = { warn, block, max, unknownQuota: unknown.value };
  }
  const parsed = policyFromInput(values);
  if (!parsed.ok) {
    if (!input) void vscode.window.showErrorMessage(parsed.problems.join(' '));
    return { ok: false, problems: parsed.problems };
  }
  const saved = savePolicy(accounts.store, accountProfileId, parsed.policy);
  if (!saved.ok) {
    if (!input) void vscode.window.showErrorMessage('The limits could not be saved.');
    return { ok: false, reason: saved.reason };
  }
  return { ok: true };
}

/**
 * Slots held by windows or records that cannot be confirmed to be running keep blocking new agents:
 * their agents may still be running, so nothing frees them by itself. This tells the person how many there are and, only after an explicit
 * confirmation, stops counting them. Returns the number freed (0 when none or declined).
 */
export async function offerSlotRecovery(accountProfileId: string, label: string, sessions: () => SessionUse[]): Promise<number> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return 0;
  const group = groupOf(accounts as any, accountProfileId);
  if (!group.ok) return 0;
  const duplicateIds = group.ids;

  const slots = runningSlots(accounts.store, accountProfileId, new Date(), { linkedAccountKeys: duplicateIds });
  if (!slots.ok || !Number.isInteger(slots.orphaned) || (slots.orphaned as number) < 1) return 0;
  const count = slots.orphaned as number;
  const answer = await vscode.window.showWarningMessage(
    `“${label}”: ${count} running-agent slot${count === 1 ? ' is' : 's are'} held by a window or record that cannot be confirmed to still be running.`,
    { modal: true, detail: 'Nothing shows that the agents behind these slots have stopped: the window may have closed or crashed, the computer may have been renamed, or the record may be from an older version. Free them only if you have checked that those agents are not running, otherwise the account may exceed its running-agent limit.' },
    'Free These Slots'
  );
  if (answer !== 'Free These Slots') return 0;
  const result = recoverOrphanedSlots(accounts.store, accountProfileId, new Date(), { linkedAccountKeys: duplicateIds });
  return result.ok && Number.isInteger(result.recovered) ? (result.recovered as number) : 0;
}

/** Removes the saved limits (the account is then never held back). */
export async function clearLimits(accountProfileId: string, sessions: () => SessionUse[]): Promise<boolean> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return false;
  const store = accounts.store as { delete(collection: string, id: string): { ok: boolean } };
  return store.delete('policies', `quota-${accountProfileId}`).ok;
}
