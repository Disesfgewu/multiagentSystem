'use strict';

const { scanSensitive } = require('./sensitive');
const { flatten, MIN_MATCHABLE_CHARS } = require('./text');

const WINDOW = 20;

function windowsOf(flat) {
  const out = new Set();
  for (let i = 0; i + WINDOW <= flat.length; i += 1) out.add(flat.slice(i, i + WINDOW));
  return out;
}

// Detects verbatim and lightly reformatted reuse of private memory or rule text
// in outgoing GitHub content. A paraphrase will not match, so human review is
// still required for anything published; this only catches literal leaks.
//
// Matching policy by private text length (after flattening):
//   >= WINDOW chars        any 20-char run of it appearing in the outgoing text
//   MIN..WINDOW-1 chars    the whole text appearing in the outgoing text
//   < MIN chars            cannot be matched without matching ordinary words;
//                          reported in `unmatchable` instead of silently skipped
function findPrivateFragments(outgoing, { memories = [], rules = [] } = {}) {
  const findings = scanSensitive(outgoing).map((finding) => ({ code: finding.code, id: null }));
  const outgoingFlat = flatten(outgoing);
  const outgoingWindows = windowsOf(outgoingFlat);
  const unmatchable = [];

  const check = (code, id, text) => {
    const flat = flatten(text);
    if (flat.length < MIN_MATCHABLE_CHARS) {
      unmatchable.push(id);
      return;
    }
    const hit = flat.length >= WINDOW
      ? [...windowsOf(flat)].some((piece) => outgoingWindows.has(piece))
      : outgoingFlat.includes(flat);
    if (hit) findings.push({ code, id });
  };
  for (const item of memories) check('memory-fragment', item.id, item.content);
  for (const rule of rules) if (rule.text) check('rule-fragment', rule.id, rule.text);
  return { blocked: findings.length > 0, findings, unmatchable };
}

// Main still returns an array from list(); #62 changes that API to {ok, items}.
// Check status around the read so neither version treats an unreadable store as empty.
function scanMemoryStorePublication(outgoing, store, { rules = [] } = {}) {
  const unavailable = () => ({
    blocked: true,
    findings: [{ code: 'private-memory-unavailable', id: null }],
    unmatchable: []
  });
  if (!store || typeof store.status !== 'function' || typeof store.list !== 'function') return unavailable();
  try {
    if (store.status().ok !== true) return unavailable();
    const listed = store.list();
    const items = Array.isArray(listed) ? listed : listed && listed.ok === true ? listed.items : null;
    if (!Array.isArray(items) || store.status().ok !== true) return unavailable();
    return findPrivateFragments(outgoing, { memories: items, rules });
  } catch {
    return unavailable();
  }
}

module.exports = { findPrivateFragments, scanMemoryStorePublication, WINDOW, MIN_MATCHABLE_CHARS };
