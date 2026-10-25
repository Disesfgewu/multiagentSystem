'use strict';

const { locateSensitive } = require('../memory/sensitive');
const { findPrivateFragments } = require('../memory/publish-check');

// A detector is a replaceable unit: `detect(text) -> Array<{ code, category, index }>` where
// `index` is the offset of the match in `text`, or null when it can only be said that the text
// as a whole contains it. A detector returns codes and offsets, NEVER the matched text, so its
// output can be shown or logged. A detector that throws makes the scan fail closed.
//
// Credential shapes are NOT defined here: they live in src/memory/sensitive.js (one list) and
// are reused through locateSensitive. This file adds no credential rule.

const LOCATE_LIMIT = 20;

const CATEGORY = Object.freeze({
  'private-key-block': 'credential',
  'anthropic-key': 'credential',
  'api-key': 'credential',
  'github-token': 'credential',
  'cloud-access-key': 'credential',
  'slack-token': 'credential',
  jwt: 'credential',
  'bearer-token': 'credential',
  'credential-assignment': 'credential',
  'email-address': 'identifier',
  uuid: 'identifier',
  'home-path': 'local-path'
});

function sensitiveShapes() {
  return {
    name: 'sensitive-shapes',
    detect: (text) => {
      const hits = locateSensitive(text);
      const out = hits.map((hit) => ({ code: hit.code, category: CATEGORY[hit.code] || 'credential', index: hit.index }));
      // locateSensitive stops after 20 places per code: reaching that number means there may be more.
      const perCode = new Map();
      for (const hit of hits) perCode.set(hit.code, (perCode.get(hit.code) || 0) + 1);
      if ([...perCode.values()].some((count) => count >= LOCATE_LIMIT)) out.truncated = true;
      return out;
    }
  };
}

// Absolute paths on this machine that name a user, a volume or a temporary area. Repository
// relative paths (src/a.js), URLs and the interpreter in a shebang (/usr/bin/env) do not match.
// A backslash doubled by escaping (a path inside a JSON or source string literal) is the same path.
// The start boundary keeps "https://host/home/x" from matching.
//
// Every alternative here starts at a character that is not repeated in the text it consumes, so
// each start costs time proportional to the path it finds and a long run of one character cannot
// make the scan quadratic. Runs of backslashes (UNC paths) are handled by `uncPaths` below, which
// visits each run once.
const LOCAL_PATH = new RegExp(
  String.raw`(?<![A-Za-z0-9_.:/~-])(?:` +
    String.raw`/(?:Users|home|root|Volumes)/[^\s/\\"'` + '`' + String.raw`)\]]+` +
    String.raw`|/private/(?:var|tmp)/|/var/folders/` +
    String.raw`|[A-Za-z]:(?:\\+|/)(?![\\/])[^\s"'` + '`' + String.raw`]+` +
    String.raw`|~[A-Za-z0-9_-]*(?:\\+|/)\.(?:ssh|aws|gnupg|kube|docker|npmrc|netrc)(?![A-Za-z0-9_-])` +
    String.raw`|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOMEDRIVE)%` +
    String.raw`|/var/root(?:/|(?![A-Za-z0-9_-]))` +
    String.raw`)`,
  'g'
);

const BACKSLASH_RUN = /\\{2,}/g;
const UNC_TAIL = /[A-Za-z0-9_.$-]+\\+[A-Za-z0-9_$.-]+/y;
const BOUNDARY = /[A-Za-z0-9_.:/~-]/;

// \\server\share, also with every backslash doubled by escaping. Where the first backslash of a run
// follows a boundary character (a letter, a colon, ...) the match can only start one character in,
// and only when the run is long enough to leave two; this is exactly what the single pattern did.
function uncPaths(text) {
  const found = [];
  BACKSLASH_RUN.lastIndex = 0;
  let run = BACKSLASH_RUN.exec(text);
  while (run !== null) {
    const end = run.index + run[0].length;
    UNC_TAIL.lastIndex = end;
    if (UNC_TAIL.test(text)) {
      const blocked = run.index > 0 && BOUNDARY.test(text[run.index - 1]);
      if (!blocked) found.push(run.index);
      else if (run[0].length >= 3) found.push(run.index + 1);
    }
    run = BACKSLASH_RUN.exec(text);
  }
  BACKSLASH_RUN.lastIndex = 0;
  return found;
}

function localPaths() {
  return {
    name: 'local-paths',
    detect: (text) => {
      const indexes = [];
      LOCAL_PATH.lastIndex = 0;
      let match = LOCAL_PATH.exec(text);
      while (match !== null && indexes.length <= LOCATE_LIMIT) {
        indexes.push(match.index);
        match = LOCAL_PATH.exec(text);
      }
      LOCAL_PATH.lastIndex = 0;
      const all = [...indexes, ...uncPaths(text)].sort((a, b) => a - b);
      const hits = all.slice(0, LOCATE_LIMIT).map((index) => ({ code: 'local-absolute-path', category: 'local-path', index }));
      if (all.length > LOCATE_LIMIT) hits.truncated = true;
      return hits;
    }
  };
}

const MIN_KNOWN_VALUE = 4;

/**
 * Exact (case-insensitive, whole-word at an ASCII letter or digit) occurrences of values the caller knows are private: account labels,
 * session ids, system instruction snippets. The list is injected by the caller and is never stored
 * or echoed; findings carry only the caller's id. A value that is too short to match without
 * matching ordinary words is reported as unmatchable instead of being skipped quietly.
 */
// A value that begins or ends with an ASCII letter or digit is found only as a whole word on that side (#389): "test" is not in
// "latest", and an account named "Work A" is not in "Work Area". Other characters (CJK text, punctuation) still match anywhere.
const WORD = /[a-z0-9]/;

/** The first place `needle` stands in `lower` with no ASCII letter or digit glued to an end that is one, or -1. */
function wordIndex(lower, needle) {
  const open = WORD.test(needle[0]);
  const close = WORD.test(needle[needle.length - 1]);
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + 1)) {
    const before = index > 0 ? lower[index - 1] : '';
    const after = lower[index + needle.length] ?? '';
    if ((!open || !WORD.test(before)) && (!close || !WORD.test(after))) return index;
  }
  return -1;
}

function knownValues(values) {
  const usable = [];
  const unmatchable = [];
  for (const entry of values) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.value !== 'string') throw new TypeError('invalid known value');
    if (entry.value.length < MIN_KNOWN_VALUE) unmatchable.push(entry.id);
    else usable.push({ id: entry.id, needle: entry.value.toLowerCase() });
  }
  return {
    name: 'known-values',
    unmatchable,
    detect: (text) => {
      const lower = text.toLowerCase();
      const hits = [];
      for (const { id, needle } of usable) {
        const index = wordIndex(lower, needle);
        if (index >= 0) hits.push({ code: 'known-value', category: 'known-value', index, id });
      }
      return hits;
    }
  };
}

const LOCALIZE_MAX_LINES = 2000;

/**
 * Private memory and rule text, through the existing findPrivateFragments (verbatim or lightly
 * reformatted reuse). The lists are injected by the caller. A hit is localized to the lines that
 * match on their own; reuse spread over several lines is reported for the text as a whole.
 */
function privateFragments({ memories = [], rules = [] } = {}) {
  const options = { memories, rules };
  const unmatchable = new Set();
  const fragments = (text) => {
    const result = findPrivateFragments(text, options);
    for (const id of result.unmatchable) unmatchable.add(id);
    return result.findings.filter((finding) => finding.code === 'memory-fragment' || finding.code === 'rule-fragment');
  };
  const detector = {
    name: 'private-fragments',
    get unmatchable() {
      return [...unmatchable];
    },
    detect: (text) => {
      if (memories.length === 0 && rules.length === 0) return [];
      const whole = fragments(text);
      if (whole.length === 0) return [];
      const hits = [];
      const located = new Set();
      const lines = text.split('\n');
      if (lines.length <= LOCALIZE_MAX_LINES) {
        let offset = 0;
        for (const line of lines) {
          for (const finding of fragments(line)) {
            hits.push({ code: finding.code, category: 'private-fragment', index: offset, id: finding.id });
            located.add(`${finding.code}:${finding.id}`);
          }
          offset += line.length + 1;
        }
      }
      for (const finding of whole) {
        if (!located.has(`${finding.code}:${finding.id}`)) {
          hits.push({ code: finding.code, category: 'private-fragment', index: null, id: finding.id });
        }
      }
      return hits;
    }
  };
  return detector;
}

// File names that should not be added to a repository. Matched on the path, not the content.
const SENSITIVE_FILE_NAMES = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.(npmrc|pypirc|netrc)$/,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /\.(pem|p12|pfx|key|keystore)$/,
  /(^|\/)(credentials|auth)\.json$/,
  /(^|\/)\.(claude|codex)\//,
  /(^|\/)(CLAUDE\.local|AGENTS\.override)\.md$/
];
const SAFE_SUFFIX = /\.(example|sample|template|dist)$/;

function sensitiveFileName(path) {
  if (SAFE_SUFFIX.test(path)) return false;
  return SENSITIVE_FILE_NAMES.some((pattern) => pattern.test(path));
}

module.exports = { sensitiveShapes, localPaths, knownValues, privateFragments, sensitiveFileName, CATEGORY, MIN_KNOWN_VALUE };
