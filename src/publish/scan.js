'use strict';

const { parseUnifiedDiff } = require('./diff');
const detectors = require('./detectors');

// Scans text that is about to be published to GitHub (a commit message, an Issue or PR title and
// body, a review or comment, a branch name, the added lines and new paths of a diff) for private
// data. It is a SHAPE and VERBATIM detector. It cannot see a paraphrase, a translation, text that
// was split up or encoded, or a secret that does not look like one. A human still has to review
// anything published. Findings carry a code, a category and a location, never the matched text.
//
// It fails closed: input that is too large or malformed, a detector that throws, and content that
// cannot be scanned (a binary file) all block instead of passing.

const KINDS = Object.freeze([
  'commit-message',
  'issue-title',
  'issue-body',
  'pr-title',
  'pr-body',
  'review',
  'comment',
  'branch-name',
  'diff',
  'broker-payload'
]);

const LIMITS = Object.freeze({
  maxUnits: 200,
  maxUnitChars: 2_000_000,
  maxTotalChars: 8_000_000,
  maxFindings: 200
});

const LIMITATIONS = Object.freeze([
  'paraphrase-not-detected',
  'translation-not-detected',
  'split-or-encoded-not-detected',
  'unknown-secret-formats-not-detected',
  'human-review-still-required'
]);

const HINTS = Object.freeze({
  credential: 'Remove the credential and rotate it if it was ever shared; keep credentials out of GitHub.',
  identifier: 'Remove or replace the identifier (an email address or an id that could name a person or session).',
  'local-path': 'Replace the machine-specific path with a repository-relative path or a placeholder.',
  'private-fragment': 'This repeats private memory or rule text. Remove it or reword it in your own public words.',
  'known-value': 'This matches a value registered as private (an account label, a session id or an instruction). Remove it.',
  'file-name': 'This file name usually holds private data. Do not add it to the repository.',
  unscannable: 'This content could not be scanned. Review it by hand before publishing.'
});

// In source code, `token = crypto.randomBytes(8)` or `const secret = process.env.X` are ordinary
// code, not a secret. For added lines in these file types the shared `credential-assignment` shape
// only counts when the assigned value is a quoted string literal (`password = "hunter2hunter2"`).
// Shell, PowerShell, config, data and text files keep the strict shape: there an unquoted value
// is often the secret itself. Every other shape (tokens, keys, paths, ...) is unaffected.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|c|h|cc|cpp|hpp)$/i;
// A quoted literal: single or double quotes, or a template literal that is not only an interpolation.
const QUOTED_LITERAL = /^[A-Za-z_-]+\s*[:=]\s*(?:["'][^"'\s]{8,}["']|`(?!\$\{)[^`\s]{8,}`)/;

function codeRefine(text, hit) {
  if (hit.code !== 'credential-assignment' || hit.index === null || hit.index === undefined) return true;
  return QUOTED_LITERAL.test(text.slice(hit.index, hit.index + 300));
}

const error = (reason) => ({
  status: 'error',
  blocked: true,
  reason,
  scanned: 0,
  findings: [],
  unmatchable: [],
  unscanned: [],
  truncated: false,
  limitations: LIMITATIONS
});

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function locate(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

/**
 * @param {Array<{ kind: string, text: string }>} units what is about to be published
 * @param {object} [options]
 * @param {Array<{ id: string, content: string }>} [options.memories] private memory, supplied by the caller
 * @param {Array<{ id: string, text: string }>} [options.rules] private rule text, supplied by the caller
 * @param {Array<{ id: string, value: string }>} [options.knownValues] values known to be private
 * @param {Array<{ name: string, detect(text: string): object[] }>} [options.detectors] replaces the default detectors
 * @returns {object} { status: 'clear'|'blocked'|'incomplete'|'error', blocked, findings, unmatchable, unscanned,
 *   privateReference: 'supplied'|'none-supplied', ... }
 */
function scanPublication(units, options = {}) {
  try {
    return run(units, options);
  } catch {
    // Never pass on an error, and never include its message (it could hold the scanned text).
    return error('scanner-failed');
  }
}

function run(units, options) {
  if (!Array.isArray(units) || units.length === 0) return error('invalid-input');
  if (units.length > LIMITS.maxUnits) return error('input-too-large');
  let total = 0;
  for (const unit of units) {
    if (!unit || !KINDS.includes(unit.kind) || typeof unit.text !== 'string') return error('invalid-input');
    if (unit.text.length > LIMITS.maxUnitChars) return error('input-too-large');
    total += unit.text.length;
  }
  if (total > LIMITS.maxTotalChars) return error('input-too-large');

  const known = detectors.knownValues(options.knownValues || []);
  const fragments = detectors.privateFragments({ memories: options.memories, rules: options.rules });
  const active = options.detectors || [detectors.sensitiveShapes(), detectors.localPaths(), fragments, known];

  const findings = [];
  const unscanned = [];
  const seen = new Set();
  let truncated = false;

  const add = (finding) => {
    const key = `${finding.unit}|${finding.fileIndex ?? ''}|${finding.line ?? ''}|${finding.column ?? ''}|${finding.category}|${finding.id ?? ''}|${finding.code}`;
    // The same place reported by two detectors with the same category (e.g. a home path) is one finding.
    const place = `${finding.unit}|${finding.fileIndex ?? ''}|${finding.line ?? ''}|${finding.column ?? ''}|${finding.category}`;
    if (seen.has(key) || (finding.category === 'local-path' && finding.column !== null && seen.has(place))) return;
    seen.add(key);
    if (finding.category === 'local-path' && finding.column !== null) seen.add(place);
    if (findings.length >= LIMITS.maxFindings) {
      truncated = true;
      return;
    }
    findings.push(finding);
  };

  // Runs every detector on `text` and reports hits with positions mapped by `where(index)`.
  const scanText = (text, base, where, keep = () => true) => {
    const starts = lineStarts(text);
    for (const detector of active) {
      const hits = detector.detect(text);
      // A detector that stopped at its own cap says so; the result then reports the truncation.
      if (hits && hits.truncated === true) truncated = true;
      for (const hit of hits) {
        if (!keep(text, hit)) continue;
        const position = hit.index === null || hit.index === undefined ? { line: null, column: null } : where(locate(starts, hit.index));
        add({ ...base, code: hit.code, category: hit.category, ...position, ...(hit.id !== undefined ? { id: hit.id } : {}), hint: HINTS[hit.category] || HINTS.credential });
      }
    }
  };

  units.forEach((unit, index) => {
    const base = { unit: index, kind: unit.kind };
    if (unit.kind !== 'diff') {
      scanText(unit.text, base, (place) => place);
      return;
    }
    const diff = parseUnifiedDiff(unit.text);
    if (diff.malformed) {
      // Not understood with confidence: scan everything, including removed and context lines,
      // rather than trust a partial reading.
      scanText(unit.text, { ...base, degraded: 'unparsed-diff' }, (place) => place);
      // Binary content cannot be scanned however the diff was read: never let it pass as clear.
      if (/^(?:Binary files .* differ|GIT binary patch)\s*$/m.test(unit.text)) {
        unscanned.push({ unit: index, fileIndex: null, reason: 'binary-content', hint: HINTS.unscannable });
      }
      return;
    }
    for (const file of diff.files) {
      const fileBase = { ...base, fileIndex: file.index };
      for (const path of [file.newPath].filter((value) => typeof value === 'string')) {
        scanText(path, { ...fileBase, kind: 'file-path' }, () => ({ line: null, column: null }));
        if ((file.isNew || file.isRename) && detectors.sensitiveFileName(path)) {
          add({ ...fileBase, kind: 'file-path', code: 'sensitive-file-name', category: 'file-name', line: null, column: null, hint: HINTS['file-name'] });
        }
      }
      if (file.binary) {
        unscanned.push({ unit: index, fileIndex: file.index, reason: 'binary-content', hint: HINTS.unscannable });
        continue;
      }
      if (file.added.length === 0) continue;
      const text = file.added.map((added) => added.text).join('\n');
      const keep = typeof file.newPath === 'string' && CODE_FILE.test(file.newPath) ? codeRefine : undefined;
      scanText(text, fileBase, (place) => ({ line: file.added[place.line - 1].line, column: place.column }), keep);
    }
  });

  const unmatchable = [...new Set([...known.unmatchable, ...fragments.unmatchable])];
  // "clear" with no private material supplied is not the same as "checked against private
  // material and found nothing"; callers that gate on the result must be able to tell.
  const supplied = ['memories', 'rules', 'knownValues'].some((key) => Array.isArray(options[key]) && options[key].length > 0);
  let status = 'clear';
  if (findings.length > 0) status = 'blocked';
  else if (unscanned.length > 0) status = 'incomplete';
  return {
    status,
    blocked: status !== 'clear',
    scanned: units.length,
    findings,
    unmatchable,
    unscanned,
    truncated,
    privateReference: supplied ? 'supplied' : 'none-supplied',
    limitations: LIMITATIONS
  };
}

module.exports = { scanPublication, KINDS, LIMITS, LIMITATIONS, HINTS };
