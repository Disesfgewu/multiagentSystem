'use strict';

/**
 * What the `gh` wrapper in an agent's terminal does with one call (issue #342). Pure: it reads no file and starts no program; the
 * runner (`run.js`) gives it the body text it read and carries out the answer.
 *
 * Only the five commands that post text are looked at: `gh pr create|comment|review` and `gh issue create|comment`. For those:
 *   - the body's first line becomes the session's signature (`— Worker-01`) when it is not already;
 *   - a body or title that signs as another codename, or claims to be the owner, is refused;
 *   - anything the wrapper cannot read for sure is refused (fail closed): an unknown flag, a flag given twice, a short-flag
 *     cluster, an editor or browser that would let the text be written where the wrapper cannot see it, a body it was not given.
 * Every other `gh` call is passed through unchanged.
 *
 * A signature is a claim, not proof: an agent that wants to can call the real `gh` by its full path. This is a guard against
 * mistakes and casual impersonation, not access control.
 */

const CODENAME = /^(?:PM|[A-Z][a-z]{1,19})-[0-9]{2,4}$/;
const MAX_BODY_CHARS = 65536; // GitHub's own limit for a body
/** Where the runner puts the path of the file holding the signed body. */
const BODY_FILE = Object.freeze({ bodyFile: true });

// For each command: its flags, `true` for one that takes a value. Help is handled before this.
const VALUE = true;
const SWITCH = false;
const COMMON = { repo: VALUE };
const FLAGS = Object.freeze({
  'pr create': { assignee: VALUE, base: VALUE, body: VALUE, 'body-file': VALUE, draft: SWITCH, 'dry-run': SWITCH, editor: SWITCH, fill: SWITCH, 'fill-first': SWITCH, 'fill-verbose': SWITCH, head: VALUE, label: VALUE, milestone: VALUE, 'no-maintainer-edit': SWITCH, project: VALUE, recover: VALUE, reviewer: VALUE, template: VALUE, title: VALUE, web: SWITCH, ...COMMON },
  'pr comment': { body: VALUE, 'body-file': VALUE, 'create-if-none': SWITCH, 'delete-last': SWITCH, 'edit-last': SWITCH, editor: SWITCH, web: SWITCH, yes: SWITCH, ...COMMON },
  'pr review': { approve: SWITCH, body: VALUE, 'body-file': VALUE, comment: SWITCH, 'request-changes': SWITCH, ...COMMON },
  'issue create': { assignee: VALUE, body: VALUE, 'body-file': VALUE, editor: SWITCH, label: VALUE, milestone: VALUE, project: VALUE, recover: VALUE, template: VALUE, title: VALUE, web: SWITCH, ...COMMON },
  'issue comment': { body: VALUE, 'body-file': VALUE, 'create-if-none': SWITCH, 'delete-last': SWITCH, 'edit-last': SWITCH, editor: SWITCH, web: SWITCH, yes: SWITCH, ...COMMON },
  // Editing replaces the whole body, so a new body is signed like a new post; editing only other fields is passed on.
  'pr edit': { 'add-assignee': VALUE, 'add-label': VALUE, 'add-project': VALUE, 'add-reviewer': VALUE, base: VALUE, body: VALUE, 'body-file': VALUE, milestone: VALUE, 'remove-assignee': VALUE, 'remove-label': VALUE, 'remove-milestone': SWITCH, 'remove-project': VALUE, 'remove-reviewer': VALUE, title: VALUE, ...COMMON },
  'issue edit': { 'add-assignee': VALUE, 'add-label': VALUE, 'add-project': VALUE, body: VALUE, 'body-file': VALUE, milestone: VALUE, 'remove-assignee': VALUE, 'remove-label': VALUE, 'remove-milestone': SWITCH, 'remove-project': VALUE, title: VALUE, ...COMMON }
});
const EDITS = Object.freeze(['pr edit', 'issue edit']);
const SHORT = Object.freeze({
  'pr create': { a: 'assignee', B: 'base', b: 'body', F: 'body-file', d: 'draft', e: 'editor', f: 'fill', H: 'head', l: 'label', m: 'milestone', p: 'project', r: 'reviewer', T: 'template', t: 'title', w: 'web', R: 'repo' },
  'pr comment': { b: 'body', F: 'body-file', e: 'editor', w: 'web', R: 'repo' },
  'pr review': { a: 'approve', b: 'body', F: 'body-file', c: 'comment', r: 'request-changes', R: 'repo' },
  'issue create': { a: 'assignee', b: 'body', F: 'body-file', e: 'editor', l: 'label', m: 'milestone', p: 'project', T: 'template', t: 'title', w: 'web', R: 'repo' },
  'issue comment': { b: 'body', F: 'body-file', e: 'editor', w: 'web', R: 'repo' },
  'pr edit': { B: 'base', b: 'body', F: 'body-file', m: 'milestone', t: 'title', R: 'repo' },
  'issue edit': { b: 'body', F: 'body-file', m: 'milestone', t: 'title', R: 'repo' }
});

/**
 * The first word of a call that is passed on: gh's own top-level commands (from `gh help` of gh 2.62). Anything else is an alias
 * or an extension, which could stand for a posting command the wrapper would not recognize, so it is refused.
 */
const TOP_LEVEL = Object.freeze(['alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'extension', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'preview', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'version', 'workflow']);
/** Subcommands refused outright: they would let a later call mean something the wrapper cannot see, or change the sign-in. */
const REFUSED = Object.freeze({
  alias: { set: 'alias', import: 'alias', delete: 'alias' },
  extension: { install: 'extension', exec: 'extension', upgrade: 'extension', create: 'extension' },
  // Only `gh auth status` is passed on: an agent does not sign in, out, or read the sign-in's token through this terminal.
  auth: { login: 'auth', logout: 'auth', refresh: 'auth', switch: 'auth', token: 'auth', 'setup-git': 'auth' }
});
// gh's own subcommands of `pr` and `issue` (gh 2.62), with the short names gh itself accepts for them: `gh pr new` IS `pr create`.
const SUBCOMMANDS = Object.freeze({
  pr: { checkout: 'checkout', co: 'checkout', checks: 'checks', close: 'close', comment: 'comment', create: 'create', new: 'create', diff: 'diff', edit: 'edit', list: 'list', ls: 'list', lock: 'lock', merge: 'merge', ready: 'ready', reopen: 'reopen', review: 'review', status: 'status', unlock: 'unlock', 'update-branch': 'update-branch', view: 'view' },
  issue: { close: 'close', comment: 'comment', create: 'create', new: 'create', delete: 'delete', develop: 'develop', edit: 'edit', list: 'list', ls: 'list', lock: 'lock', pin: 'pin', reopen: 'reopen', status: 'status', transfer: 'transfer', unlock: 'unlock', unpin: 'unpin', view: 'view' }
});
// Closing or reopening with a comment posts that comment, which cannot be signed through a flag value.
const CLOSE_WITH_COMMENT = Object.freeze(['pr close', 'pr reopen', 'issue close', 'issue reopen']);
// The text would be written in an editor, a browser or a form the wrapper never sees.
const UNSEEN = Object.freeze({ editor: 'editor', web: 'browser', recover: 'saved-input' });

// `gh api`: its flags, so a value is never mistaken for a flag and the other way round. Only a call that reads is passed on.
const API_FLAGS = Object.freeze({ method: VALUE, header: VALUE, 'raw-field': VALUE, field: VALUE, input: VALUE, jq: VALUE, template: VALUE, cache: VALUE, hostname: VALUE, preview: VALUE, include: SWITCH, paginate: SWITCH, silent: SWITCH, slurp: SWITCH, verbose: SWITCH });
const API_SHORT = Object.freeze({ X: 'method', H: 'header', f: 'raw-field', F: 'field', q: 'jq', t: 'template', p: 'preview', i: 'include' });
// Any of these makes gh send data (and switch to POST by itself).
const API_SENDS = Object.freeze(['raw-field', 'field', 'input']);

const pass = () => ({ action: 'pass' });
const refuse = (reason, detail) => ({ action: 'refuse', reason, ...(detail ? { detail } : {}) });

/** Reads the flags of a posting command into `{ flags: Map<name, value|true>, positional }`, or why it cannot. */
function parseFlags(command, tokens) {
  const known = FLAGS[command];
  const short = SHORT[command];
  const flags = new Map();
  const positional = [];
  const set = (name, value) => {
    if (flags.has(name)) return refuse('flag-repeated', `--${name}`);
    flags.set(name, value);
    return null;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') { positional.push(...tokens.slice(i + 1)); break; }
    if (token.startsWith('--')) {
      const at = token.indexOf('=');
      const name = at < 0 ? token.slice(2) : token.slice(2, at);
      if (!Object.hasOwn(known, name)) return refuse('flag-unknown', `--${name}`);
      let value = true;
      if (known[name] === VALUE) {
        if (at >= 0) value = token.slice(at + 1);
        else if (i + 1 < tokens.length) value = tokens[(i += 1)];
        else return refuse('flag-value-missing', `--${name}`);
      } else if (at >= 0) {
        // `--draft=false` and the like: one spelling per switch keeps the reading certain.
        return refuse('flag-unknown', token.slice(0, Math.min(token.length, 40)));
      }
      const problem = set(name, value);
      if (problem) return problem;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const letter = token[1];
      if (!Object.hasOwn(short, letter)) return refuse('flag-unknown', `-${letter}`);
      const name = short[letter];
      let value = true;
      if (known[name] === VALUE) {
        if (token.length > 2) value = token[2] === '=' ? token.slice(3) : token.slice(2);
        else if (i + 1 < tokens.length) value = tokens[(i += 1)];
        else return refuse('flag-value-missing', `-${letter}`);
      } else if (token.length > 2) {
        // A cluster such as `-db text`: refused rather than guessed.
        return refuse('flag-cluster', token.slice(0, 8));
      }
      const problem = set(name, value);
      if (problem) return problem;
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

/** `gh api`: passed on only when it certainly reads (no method or GET, and nothing sent); anything else is refused. */
function decideApi(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') break;
    let name = null;
    let value = null;
    if (token.startsWith('--')) {
      const at = token.indexOf('=');
      name = at < 0 ? token.slice(2) : token.slice(2, at);
      if (!Object.hasOwn(API_FLAGS, name)) return refuse('api-flag-unknown', `--${name.slice(0, 30)}`);
      if (API_FLAGS[name] === VALUE) value = at >= 0 ? token.slice(at + 1) : tokens[(i += 1)];
      else if (at >= 0) return refuse('api-flag-unknown', token.slice(0, 40));
    } else if (token.startsWith('-') && token.length > 1) {
      if (!Object.hasOwn(API_SHORT, token[1])) return refuse('api-flag-unknown', `-${token[1]}`);
      name = API_SHORT[token[1]];
      if (API_FLAGS[name] === VALUE) value = token.length > 2 ? (token[2] === '=' ? token.slice(3) : token.slice(2)) : tokens[(i += 1)];
      else if (token.length > 2) return refuse('flag-cluster', token.slice(0, 8));
    } else continue;
    if (API_FLAGS[name] === VALUE && value === undefined) return refuse('flag-value-missing', `--${name}`);
    if (API_SENDS.includes(name)) return refuse('api-write', `--${name}`);
    if (name === 'method' && String(value).toUpperCase() !== 'GET') return refuse('api-write', String(value).slice(0, 10));
  }
  return pass();
}

const fenced = (line) => /^\s*(?:```|~~~)/.test(line);
// Before any check a line is put in one form: characters that cannot be seen (zero-width, direction and soft-hyphen marks) are
// removed, and every Unicode dash or minus becomes the em dash. `― PM-01` and `— PM` + zero-width + `-01` are then `— PM-01`.
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const DASHES = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/g;
// Greek and Cyrillic letters that look like the Latin ones a codename is written with: a Cyrillic "Er" and "Em" make a line read
// "PM-01" to a person and something else to a computer.
const CONFUSABLES = new Map([[0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041a, 'K'], [0x041c, 'M'], [0x041d, 'H'], [0x041e, 'O'], [0x0420, 'P'], [0x0421, 'C'], [0x0422, 'T'], [0x0425, 'X'], [0x0405, 'S'], [0x0406, 'I'], [0x0408, 'J'], [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'], [0x0455, 's'], [0x0456, 'i'], [0x0458, 'j'], [0x04bb, 'h'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'], [0x0391, 'A'], [0x0392, 'B'], [0x0395, 'E'], [0x0396, 'Z'], [0x0397, 'H'], [0x0399, 'I'], [0x039a, 'K'], [0x039c, 'M'], [0x039d, 'N'], [0x039f, 'O'], [0x03a1, 'P'], [0x03a4, 'T'], [0x03a5, 'Y'], [0x03a7, 'X'], [0x03bf, 'o'], [0x03b1, 'a'], [0x03bd, 'v'], [0x03c1, 'p'], [0x03b9, 'i'], [0x03ba, 'k']]);
const LOOKALIKE = /[\u0370-\u03ff\u0400-\u052f]/g;
const LEADING_DASH = new RegExp(`^(\\s*)${DASHES.source}`);
// Every dash after the first one of the line, and the em dash put there, matched in one pass.
const OTHER_DASHES = new RegExp(`^(\\s*\u2014)|${DASHES.source}`, 'g');
/**
 * One form for every check, only for comparing (the posted text is never changed by it):
 *  1. invisible marks removed;
 *  2. a dash of any kind that starts the line becomes the em dash (the signature's);
 *  3. compatibility forms folded and combining marks removed (decomposed, marks dropped, composed again): full-width and styled
 *     letters and digits become plain ones, an accented P is a P;
 *  4. Greek and Cyrillic look-alikes of Latin letters replaced;
 *  5. every other dash becomes the ASCII hyphen, as in a codename.
 */
const normalizeLine = (line) => String(line)
  .replace(INVISIBLE, '')
  .replace(LEADING_DASH, '$1\u2014')
  .normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
  .replace(LOOKALIKE, (char) => CONFUSABLES.get(char.codePointAt(0)) ?? char)
  .replace(OTHER_DASHES, (match, lead) => lead ?? '-');
// Every line break GitHub shows as one, including the Unicode line and paragraph separators.
const LINES = /\r\n|[\n\r\u0085\u2028\u2029]/;
// A signature: after a Unicode dash, a name at the start of the line (anything may follow); after the ASCII hyphen, only a line that
// is nothing else, because `- item` is a Markdown list.
const SIGNED_DASH = /^\s*\u2014\s*([A-Za-z][A-Za-z]{0,19}-[0-9]{1,4})(?![0-9])/;
const SIGNED_HYPHEN = /^\s*-{1,2}\s*([A-Za-z][A-Za-z]{0,19}-[0-9]{1,4})\s*$/;
const OWNER_WORDS = '(?:\u7ba1\u7406\u8005|\u7ba1\u7406\u54e1|\u7ba1\u7406\u5458|repo\\s+owner|owner|maintainer|admin(?:istrator)?)';
const OWNER_DASH = new RegExp(`^\\s*\u2014\\s*${OWNER_WORDS}(?![A-Za-z])`, 'i');
const OWNER_STANDALONE = new RegExp(`^\\s*\u2014\\s*${OWNER_WORDS}\\s*$`, 'i');
const OWNER_HYPHEN = new RegExp(`^\\s*-{1,2}\\s*${OWNER_WORDS}\\s*$`, 'i');
const OWNER_CLAIMS = [/\u6211(?:\u5c31)?\u662f(?:\u9019\u500b\u5c08\u6848\u7684|\u8fd9\u4e2a\u9879\u76ee\u7684)?\u7ba1\u7406(?:\u8005|\u54e1|\u5458)/, /\u4ee5\u7ba1\u7406(?:\u8005|\u54e1|\u5458)(?:\u7684)?\u8eab(?:\u5206|\u4efd)/, /\b(?:i\s+am|i'm)\s+the\s+(?:repo(?:sitory)?\s+)?(?:owner|maintainer|admin(?:istrator)?)\b/i, /\bspeaking\s+as\s+the\s+(?:owner|maintainer)\b/i];
const signedAs = (line) => { const normal = normalizeLine(line); const match = SIGNED_DASH.exec(normal) ?? SIGNED_HYPHEN.exec(normal); return match ? match[1] : null; };
// A line that is a signature and nothing else: how a sign-off written further down a comment looks. A list item that starts with a
// dash and names an agent ("- PM-01 please check") is not one.
const STANDALONE = /^\s*(?:\u2014|-{1,2})\s*([A-Za-z][A-Za-z]{0,19}-[0-9]{1,4})\s*$/;
const standaloneAs = (line) => { const match = STANDALONE.exec(normalizeLine(line)); return match ? match[1] : null; };

/**
 * Why `text` must not be posted under `own`, or null. Quoted lines (`>`) and fenced code are someone else's words and not checked.
 * The first line is where a signature is read (by the report page too), so there a dash and a codename at the start count whatever
 * follows; further down only a line that is a signature and nothing else does, so a list that names an agent is still allowed.
 * Claims to be the owner are refused on any line.
 */
function impersonation(text, own) {
  let inCode = false;
  let index = -1;
  for (const raw of String(text).split(LINES)) {
    index += 1;
    if (fenced(raw)) { inCode = !inCode; continue; }
    if (inCode || /^\s*>/.test(normalizeLine(raw))) continue;
    const signed = index === 0 ? signedAs(raw) : standaloneAs(raw);
    if (signed && signed !== own) return refuse('other-codename', signed.slice(0, 30));
    const normal = normalizeLine(raw);
    if ((index === 0 && OWNER_DASH.test(normal)) || OWNER_HYPHEN.test(normal) || OWNER_STANDALONE.test(normal)) return refuse('owner-claim');
    if (OWNER_CLAIMS.some((pattern) => pattern.test(normal))) return refuse('owner-claim');
  }
  return null;
}

/**
 * The body with the signature as its first line. A first line that is only the session's own signature (any dash, invisible marks
 * removed) is written the one way and nothing else is touched: everything from the first line break on is kept byte for byte, with
 * its own kind of line breaks. Anything else gets the signature in front of it.
 */
function signBody(body, own) {
  const text = String(body ?? '');
  const signature = `\u2014 ${own}`;
  const breakAt = text.search(LINES);
  const firstLine = breakAt < 0 ? text : text.slice(0, breakAt);
  const first = normalizeLine(firstLine).trim();
  if (first === signature || (SIGNED_HYPHEN.test(first) && signedAs(first) === own)) return breakAt < 0 ? signature : `${signature}${text.slice(breakAt)}`;
  return text.trim() === '' ? signature : `${signature}\n\n${text}`;
}

/**
 * @param {string[]} argv what was typed after `gh`
 * @param {{ codename: string, body?: (source: { kind: 'text', text: string } | { kind: 'file', path: string } | { kind: 'stdin' }) => { ok: true, text: string } | { ok: false, reason: string } }} context
 *   `body` reads a body the call points at (a file or standard input); without it, such a call is refused.
 * @returns {{ action: 'pass' } | { action: 'refuse', reason: string, detail?: string } | { action: 'run', argv: Array<string | typeof BODY_FILE>, body: string }}
 */
function decide(argv, context = {}) {
  const own = context.codename;
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) return refuse('arguments-invalid');
  if (typeof own !== 'string' || !CODENAME.test(own)) return refuse('no-codename');
  const [first, second] = argv;
  if (first === undefined) return pass();
  if (first.startsWith('-')) {
    // `gh --version`, `gh --help`: nothing is posted. A flag before the command hides which command it is, so a call that names
    // a posting command anywhere is refused rather than guessed.
    return argv.some((token) => token === 'pr' || token === 'issue') ? refuse('command-unclear') : pass();
  }
  if (!TOP_LEVEL.includes(first)) return refuse('command-not-allowed', first.slice(0, 30));
  if (Object.hasOwn(SUBCOMMANDS, first) && second !== undefined && !second.startsWith('-')) {
    if (!Object.hasOwn(SUBCOMMANDS[first], second)) return refuse('command-not-allowed', `${first} ${second.slice(0, 20)}`);
    // The rest is judged under gh's own name for the subcommand.
    if (SUBCOMMANDS[first][second] !== second) return decide([first, SUBCOMMANDS[first][second], ...argv.slice(2)], context);
  }
  if (Object.hasOwn(SUBCOMMANDS, first) && second !== undefined && second.startsWith('-') && argv.slice(1).some((token) => Object.hasOwn(SUBCOMMANDS[first], token) && ['create', 'comment', 'review', 'edit', 'close', 'reopen'].includes(SUBCOMMANDS[first][token]))) return refuse('command-unclear');
  if (Object.hasOwn(REFUSED, first) && second !== undefined && Object.hasOwn(REFUSED[first], second)) return refuse('subcommand-refused', `${first} ${second}`);
  if (first === 'auth' && second !== undefined && second !== 'status' && !second.startsWith('-')) return refuse('subcommand-refused', `auth ${second.slice(0, 20)}`);
  if (CLOSE_WITH_COMMENT.includes(`${first} ${second}`) && argv.slice(2).some((token) => /^(?:--comment(?:=|$)|-c)/.test(token))) return refuse('comment-on-close');
  if (first === 'api') {
    const rest = argv.slice(1);
    return rest.includes('--help') || rest.includes('-h') ? pass() : decideApi(rest);
  }
  const command = `${first} ${second ?? ''}`;
  if (!Object.hasOwn(FLAGS, command)) return pass();
  const rest = argv.slice(2);
  if (rest.includes('--help') || rest.includes('-h')) return pass();
  const parsed = parseFlags(command, rest);
  if (parsed.action === 'refuse') return parsed;
  const { flags } = parsed;
  for (const [name, why] of Object.entries(UNSEEN)) if (flags.has(name)) return refuse('text-not-seen', why);

  // A NUL character cannot be posted as text and could cut what gh reads short of what was checked.
  for (const name of ['title', 'body']) if (flags.has(name) && String(flags.get(name)).includes('\u0000')) return refuse('text-invalid', name);
  if (flags.has('title')) {
    const problem = impersonation(flags.get('title'), own);
    if (problem) return problem;
  }
  if (flags.has('body') && flags.has('body-file')) return refuse('flag-repeated', 'body');
  // An edit that leaves the body alone posts no new text: the title was checked above.
  if (EDITS.includes(command) && !flags.has('body') && !flags.has('body-file')) return pass();
  // Deleting the last comment posts no text.
  if (flags.has('delete-last')) return flags.has('body') || flags.has('body-file') ? refuse('flag-conflict', 'delete-last') : pass();

  let body;
  if (flags.has('body')) {
    body = String(flags.get('body'));
  } else if (flags.has('body-file')) {
    const where = String(flags.get('body-file'));
    if (typeof context.body !== 'function') return refuse('body-unreadable');
    const read = context.body(where === '-' ? { kind: 'stdin' } : { kind: 'file', path: where });
    if (!read || read.ok !== true || typeof read.text !== 'string') return refuse('body-unreadable', read && typeof read.reason === 'string' ? read.reason : undefined);
    body = read.text;
  } else if (command === 'pr review') {
    // A review that only approves or requests changes still carries the signature; one with no action would ask interactively.
    if (!flags.has('approve') && !flags.has('comment') && !flags.has('request-changes')) return refuse('text-not-seen', 'prompt');
    body = '';
  } else {
    // Without a body gh asks for it (or, with --fill, writes one from the commits) where the wrapper cannot sign it.
    return refuse('body-missing');
  }
  if (body.includes('\u0000')) return refuse('text-invalid', 'body');
  const problem = impersonation(body, own);
  if (problem) return problem;
  const signed = signBody(body, own);
  if (signed.length > MAX_BODY_CHARS) return refuse('body-too-large');

  // The signed body always travels in a file: it is never re-quoted for a shell and has no command-line length limit.
  const out = [first, second];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--') { out.push(...rest.slice(i)); break; }
    const longName = token.startsWith('--') ? token.slice(2).split('=')[0] : null;
    const shortName = !longName && token.startsWith('-') && token.length > 1 ? SHORT[command][token[1]] : null;
    const name = longName ?? shortName;
    if (name === 'body' || name === 'body-file') {
      // Skip the flag and, when it was given separately, its value.
      if (!token.includes('=') && (longName ? true : token.length === 2)) i += 1;
      continue;
    }
    out.push(token);
    if (name && FLAGS[command][name] === VALUE && !token.includes('=') && (longName ? true : token.length === 2)) out.push(rest[(i += 1)]);
  }
  const dashDash = out.indexOf('--');
  const insertAt = dashDash < 0 ? out.length : dashDash;
  out.splice(insertAt, 0, '--body-file', BODY_FILE);
  return { action: 'run', argv: out, body: signed };
}

/** One sentence for the agent: why the call was refused and what to do instead. */
function explain(reason, detail) {
  const what = detail ? ` (${detail})` : '';
  const texts = {
    'no-codename': 'this terminal has no agent codename, so nothing can be signed',
    'arguments-invalid': 'the arguments could not be read',
    'command-unclear': 'put the command first, for example `gh pr comment 12 --body "..."`',
    'flag-unknown': `the flag${what} is not one this wrapper reads for sure`,
    'flag-repeated': `the flag${what} was given more than once`,
    'flag-cluster': `short flags${what} must be given one at a time`,
    'flag-value-missing': `the flag${what} has no value`,
    'flag-conflict': `the flags${what} cannot be combined`,
    'text-not-seen': `the text would be written in an ${detail === 'browser' ? 'browser' : detail === 'prompt' ? 'interactive prompt' : detail === 'saved-input' ? 'earlier, saved input' : 'editor'} the wrapper cannot sign; give it with --body or --body-file`,
    'body-missing': 'give the text with --body or --body-file so it can be signed',
    'text-invalid': `the ${detail === 'title' ? 'title' : 'body'} contains a NUL character`,
    'body-unreadable': `the body file could not be read${what}`,
    'body-too-large': 'the signed body is longer than GitHub accepts',
    'other-codename': `the text signs as another agent${what}; sign only as yourself`,
    'owner-claim': 'the text claims to be the owner; agents never sign or speak as the owner',
    'real-gh-missing': 'the real gh program could not be found, so nothing was sent',
    'api-write': `gh api may only read here${what}; post with \`gh issue comment\` or \`gh pr comment|review|create\`, which sign the text`,
    'command-not-allowed': `\`gh ${detail}\` is not one of gh's own commands (an alias or an extension), so it is not passed on`,
    'subcommand-refused': `\`gh ${detail}\` is not allowed in an agent's terminal`,
    'comment-on-close': 'closing or reopening with --comment cannot be signed; post the comment with `gh issue comment` or `gh pr comment` first, then close without --comment',
    'api-flag-unknown': `the gh api flag${what} is not one this wrapper reads for sure`
  };
  return `multiagent gh wrapper: refused: ${texts[reason] ?? reason}. Nothing was sent.`;
}

// `signedAs` and `normalizeLine` are also how the report page reads a signature (`src/reports/authorship.js`), so the two never disagree.
module.exports = { decide, explain, signBody, impersonation, signedAs, normalizeLine, LINES, BODY_FILE, MAX_BODY_CHARS, FLAGS, SHORT };
