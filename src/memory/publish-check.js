'use strict';

const { scanSensitive } = require('./sensitive');

const WINDOW = 20;

const squash = (text) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

function windowsOf(text) {
  const flat = squash(text);
  const out = new Set();
  if (flat.length < WINDOW) return out;
  for (let i = 0; i + WINDOW <= flat.length; i += 1) out.add(flat.slice(i, i + WINDOW));
  return out;
}

// Detects exact and lightly-reformatted reuse of private memory or rule text in
// outgoing GitHub content. A paraphrase will not match, so a human review is
// still required for anything published; this only catches verbatim leaks.
function findPrivateFragments(outgoing, { memories = [], rules = [] } = {}) {
  const findings = scanSensitive(outgoing).map((finding) => ({ code: finding.code, id: null }));
  const outgoingWindows = windowsOf(outgoing);

  const check = (code, id, text) => {
    for (const piece of windowsOf(text)) {
      if (outgoingWindows.has(piece)) {
        findings.push({ code, id });
        return;
      }
    }
  };
  for (const item of memories) check('memory-fragment', item.id, item.content);
  for (const rule of rules) if (rule.text) check('rule-fragment', rule.id, rule.text);
  return { blocked: findings.length > 0, findings };
}

module.exports = { findPrivateFragments, WINDOW };
