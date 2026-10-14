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

module.exports = { findPrivateFragments, WINDOW, MIN_MATCHABLE_CHARS };
