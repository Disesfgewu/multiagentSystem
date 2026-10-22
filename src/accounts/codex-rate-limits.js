'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { codexQuotaFromSessionLog } = require('./observation');

/**
 * Codex's own usage numbers, read from the session log it writes on this computer (issue #302): the rollout files under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/`, whose `token_count` events carry the account's rate limits and the token counts of the last
 * request. This is a read of local files, not a service call: nothing is sent anywhere, and the credential files of the profile
 * (`auth.json` and the like) are never opened, because the only paths this module ever opens are rollout files under `sessions`.
 *
 * Read-only, bounded and fail-closed:
 *  - every level is checked with `lstat`; a link, or anything that is not a plain folder or file, is not followed or read;
 *  - a file is read from its END, at most MAX_TAIL_BYTES of it, and a line longer than MAX_LINE_BYTES is skipped;
 *  - only the few fields below are kept. No prompt, no output text, no path and no other field survives: the result is built from
 *    numbers and short code-like strings only;
 *  - anything missing, out of range, of the wrong type, in the future or past its reset is `unknown` with a reason, never 0.
 *
 * The log format is Codex's own, not an interface OpenAI promises. When a release changes it, the fields stop matching and the
 * reading becomes unknown (`codex-format-changed`); nothing here guesses.
 */

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 1000;
const MAX_FILES_TRIED = 6;
const MAX_DAY_FOLDERS = 14;
const YEAR = /^\d{4}$/;
const TWO = /^\d{2}$/;
const ROLLOUT = /^rollout-([A-Za-z0-9._:-]{1,120})\.jsonl$/;
const PLAN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const unknown = (reason) => ({ ok: false, reason });

/** Plain entries of a folder, names only, newest (highest) name first; a link or a file where a folder is expected is dropped. */
function folderNames(dir, accept, fsImpl, wantDirectories) {
  let info;
  try { info = fsImpl.lstatSync(dir); } catch { return { ok: false, reason: 'missing' }; }
  if (!info.isDirectory() || info.isSymbolicLink()) return { ok: false, reason: 'unsafe' };
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return { ok: false, reason: 'unreadable' }; }
  // Newest first BEFORE the limit: the entries that are kept are the newest ones, not the first the disk happened to list.
  names = names.filter((name) => accept.test(name)).sort().reverse();
  if (names.length > MAX_DIR_ENTRIES) names = names.slice(0, MAX_DIR_ENTRIES);
  const kept = [];
  for (const name of names) {
    if (!accept.test(name)) continue;
    let entry;
    try { entry = fsImpl.lstatSync(path.join(dir, name)); } catch { continue; }
    if (entry.isSymbolicLink()) continue;
    if (wantDirectories ? entry.isDirectory() : entry.isFile()) kept.push(name);
  }
  return { ok: true, names: kept };
}

/** The newest rollout files, newest first, from the newest day folders. */
function newestRollouts(sessionsDir, fsImpl) {
  const files = [];
  const years = folderNames(sessionsDir, YEAR, fsImpl, true);
  if (!years.ok) return { ok: false, reason: years.reason === 'missing' ? 'no-sessions-folder' : 'sessions-unsafe' };
  let days = 0;
  for (const year of years.names) {
    const months = folderNames(path.join(sessionsDir, year), TWO, fsImpl, true);
    if (!months.ok) continue;
    for (const month of months.names) {
      const dayFolders = folderNames(path.join(sessionsDir, year, month), TWO, fsImpl, true);
      if (!dayFolders.ok) continue;
      for (const day of dayFolders.names) {
        days += 1;
        const found = folderNames(path.join(sessionsDir, year, month, day), ROLLOUT, fsImpl, false);
        if (found.ok) for (const name of found.names) files.push(path.join(sessionsDir, year, month, day, name));
        // Out of room to look: with nothing found that is "no session files", not an empty list of files to try.
        if (files.length >= MAX_FILES_TRIED || days >= MAX_DAY_FOLDERS) return files.length > 0 ? { ok: true, files: files.slice(0, MAX_FILES_TRIED) } : { ok: false, reason: 'no-session-files' };
      }
    }
  }
  return files.length > 0 ? { ok: true, files: files.slice(0, MAX_FILES_TRIED) } : { ok: false, reason: 'no-session-files' };
}

/** The last MAX_TAIL_BYTES of a plain file, never through a link. */
function readTail(file, fsImpl) {
  let fd;
  try {
    const before = fsImpl.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) return unknown('log-unreadable');
    const flags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW ?? 0) | (fsImpl.constants.O_NONBLOCK ?? 0);
    fd = fsImpl.openSync(file, flags);
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile()) return unknown('log-unreadable');
    const length = Math.min(opened.size, MAX_TAIL_BYTES);
    const start = opened.size - length;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = fsImpl.readSync(fd, buffer, read, length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    return { ok: true, text: buffer.subarray(0, read).toString('utf8'), truncated: start > 0 };
  } catch {
    return unknown('log-unreadable');
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/**
 * The fields kept from one `token_count` event, or null when the line is not one. Everything else in the line is dropped here.
 * `rateLimits` is passed through only as the two windows' three numbers; `usage` as the five counts of the LAST request.
 */
function pickEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!isPlain(event) || event.type !== 'event_msg' || !isPlain(event.payload) || event.payload.type !== 'token_count') return null;
  const time = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
  const payload = event.payload;
  const windows = {};
  const limits = payload.rate_limits;
  let hasLimits = false;
  if (isPlain(limits)) {
    hasLimits = true;
    for (const slot of ['primary', 'secondary']) {
      const window = limits[slot];
      if (!isPlain(window)) continue;
      windows[slot] = { used_percent: typeof window.used_percent === 'number' ? window.used_percent : null, window_minutes: window.window_minutes, resets_at: window.resets_at };
    }
  }
  const last = isPlain(payload.info) && isPlain(payload.info.last_token_usage) ? payload.info.last_token_usage : null;
  const usage = last ? {
    input: natural(last.input_tokens), cachedInput: natural(last.cached_input_tokens), cacheWrite: natural(last.cache_write_input_tokens), output: natural(last.output_tokens)
  } : null;
  return {
    timeMs: time,
    hasLimits,
    rateLimits: hasLimits ? { primary: windows.primary, secondary: windows.secondary } : null,
    planType: isPlain(limits) && typeof limits.plan_type === 'string' && PLAN.test(limits.plan_type) ? limits.plan_type : null,
    usage
  };
}

/** The last `token_count` event in a block of text, scanning from the end. */
function lastTokenCount(text, truncated) {
  const lines = text.split('\n');
  // The first line of a tail read may be cut in the middle.
  if (truncated) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.length === 0 || line.length > MAX_LINE_BYTES || !line.includes('token_count')) continue;
    const picked = pickEvent(line);
    if (picked) return picked;
  }
  return null;
}

/**
 * @param {string} codexHome the profile's CODEX_HOME (an absolute folder)
 * @param {{ profileId?: string, now?: Date, fsImpl?: object }} [options] `fsImpl` lets a test see exactly which paths are opened
 * @returns {{ ok: true, observedAt: string, planType: string|null, observations: object[], usage: object|null, sessionKey: string } | { ok: false, reason: string }}
 *   Reasons: codex-home-invalid, no-sessions-folder, sessions-unsafe, no-session-files, log-unreadable, no-token-count,
 *   timestamp-invalid, timestamp-future, clock-invalid, rate-limits-absent, codex-format-changed, window-reset-passed, reading-expired.
 */
function readCodexRateLimits(codexHome, { profileId = 'codex', now = new Date(), fsImpl = fs } = {}) {
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) return unknown('codex-home-invalid');
  // Whether an event is in the future, or a window has reset, is judged against "now": a "now" that is not a time judges nothing.
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return unknown('clock-invalid');
  const sessionsDir = path.join(codexHome, 'sessions');
  const listed = newestRollouts(sessionsDir, fsImpl);
  if (!listed.ok) return unknown(listed.reason);
  let unreadable = 0;
  for (const file of listed.files) {
    const tail = readTail(file, fsImpl);
    if (!tail.ok) { unreadable += 1; continue; }
    const event = lastTokenCount(tail.text, tail.truncated);
    if (!event) continue;
    if (!Number.isFinite(event.timeMs)) return unknown('timestamp-invalid');
    if (event.timeMs > now.getTime()) return unknown('timestamp-future');
    const observedAt = new Date(event.timeMs);
    const sessionKey = `codex-${(ROLLOUT.exec(path.basename(file))?.[1] ?? 'log').replace(/[^A-Za-z0-9_-]/g, '-').slice(-80)}`;
    if (!event.hasLimits) return { ...unknown('rate-limits-absent'), observedAt: observedAt.toISOString(), usage: event.usage, sessionKey };
    // Whether a window has already reset is judged against the time NOW, not the time the event was written.
    const observations = codexQuotaFromSessionLog(event.rateLimits, { profileId, observedAt, now }).observations;
    if (observations.length === 0) return { ...unknown('codex-format-changed'), observedAt: observedAt.toISOString(), usage: event.usage, sessionKey };
    return { ok: true, observedAt: observedAt.toISOString(), planType: event.planType, observations, usage: event.usage, sessionKey };
  }
  return unknown(unreadable === listed.files.length ? 'log-unreadable' : 'no-token-count');
}

/** The usage-log entry (issue #294) for the request the last event counted, or null when it counted nothing. */
function codexUsageEntry(reading, { accountProfileId }) {
  if (!reading || !reading.usage || typeof reading.observedAt !== 'string' || typeof reading.sessionKey !== 'string') return null;
  const { input, cachedInput, cacheWrite, output } = reading.usage;
  if ([input, cachedInput, cacheWrite, output].every((value) => value === null)) return null;
  return {
    at: reading.observedAt, sessionId: reading.sessionKey, provider: 'codex', accountProfileId, model: null,
    inputTokens: input, outputTokens: output, cacheReadTokens: cachedInput, cacheWriteTokens: cacheWrite, costUsd: null,
    measurement: 'actual', source: 'codex-session-log'
  };
}

module.exports = { readCodexRateLimits, codexUsageEntry, MAX_TAIL_BYTES, MAX_LINE_BYTES, MAX_FILES_TRIED };
