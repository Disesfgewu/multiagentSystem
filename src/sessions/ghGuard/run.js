'use strict';

/**
 * The program the `gh` shim of an agent's terminal runs (issue #342): `run.js --mas-codename <codename> --mas-real <real gh> -- <what
 * was typed after gh>`. It asks `decide.js` what to do, and then passes the call on to the real `gh`, runs it with the signed body
 * in a private temporary file, or refuses with one line on standard error and exit code 2. It never sends anything itself.
 *
 * Everything that is not certain is a refusal: its own arguments, a real `gh` that is missing, a body file it cannot read.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { decide, explain, BODY_FILE } = require('./decide');

const MAX_BODY_FILE_BYTES = 1024 * 1024;
const REFUSED_EXIT = 2;
const CODENAME = /^(?:PM|[A-Z][a-z]{1,19})-[0-9]{2,4}$/;

/** Its own arguments, in the one order the shim writes them. */
function parseOwn(argv) {
  if (argv[0] !== '--mas-codename' || argv[2] !== '--mas-real' || argv[4] !== '--') return null;
  // `none` is what a shim says when the session has no codename or no real gh was found: every call is then refused for that reason.
  const codename = argv[1] === 'none' ? null : argv[1];
  const real = argv[3] === 'none' ? null : argv[3];
  if ((codename !== null && (typeof codename !== 'string' || !CODENAME.test(codename))) || (real !== null && (typeof real !== 'string' || !path.isAbsolute(real)))) return null;
  return { codename, real, rest: argv.slice(5) };
}

/** A body file (or standard input) as UTF-8 text, or why not. */
function readBody(source, { cwd = process.cwd(), readStdin = () => fs.readFileSync(0) } = {}) {
  let bytes;
  try {
    if (source.kind === 'stdin') bytes = readStdin();
    else {
      const file = path.resolve(cwd, source.path);
      const stat = fs.statSync(file);
      if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
      if (stat.size > MAX_BODY_FILE_BYTES) return { ok: false, reason: 'too-large' };
      bytes = fs.readFileSync(file);
    }
  } catch { return { ok: false, reason: 'unreadable' }; }
  if (bytes.length > MAX_BODY_FILE_BYTES) return { ok: false, reason: 'too-large' };
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch { return { ok: false, reason: 'not-utf8' }; }
}

/** Written at the top of every shim, so a shim is never taken for the real gh (it would call this program again). */
const SHIM_MARKER = 'multiagentSystem gh wrapper';

/** The real gh must be a file that exists and is not a shim. */
function realGhUsable(real) {
  let handle;
  try {
    if (!fs.statSync(real).isFile()) return false;
    handle = fs.openSync(real, 'r');
    const head = Buffer.alloc(256);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    return !head.subarray(0, read).toString('latin1').includes(SHIM_MARKER);
  } catch { return false; } finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* read only */ } } }
}

/**
 * @returns {number} the exit code to end with
 */
function main(argv, { stderr = process.stderr, spawnSync = childProcess.spawnSync, cwd = process.cwd(), readStdin, tmpdir = os.tmpdir() } = {}) {
  const own = parseOwn(argv);
  if (!own) { stderr.write(`${explain('arguments-invalid')}\n`); return REFUSED_EXIT; }
  if (own.codename === null) { stderr.write(`${explain('no-codename')}\n`); return REFUSED_EXIT; }
  if (own.real === null || !realGhUsable(own.real)) { stderr.write(`${explain('real-gh-missing')}\n`); return REFUSED_EXIT; }
  const decision = decide(own.rest, { codename: own.codename, body: (source) => readBody(source, { cwd, readStdin }) });
  if (decision.action === 'refuse') { stderr.write(`${explain(decision.reason, decision.detail)}\n`); return REFUSED_EXIT; }
  const start = (args) => {
    const result = spawnSync(own.real, args, { stdio: 'inherit', shell: false, windowsHide: false });
    if (result.error) { stderr.write(`${explain('real-gh-missing')}\n`); return REFUSED_EXIT; }
    return typeof result.status === 'number' ? result.status : 1;
  };
  if (decision.action === 'pass') return start(own.rest);
  // The signed body goes into a file only this user can read, removed again whatever happens.
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(tmpdir, 'mas-gh-'));
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, decision.body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return start(decision.argv.map((token) => (token === BODY_FILE ? file : token)));
  } catch {
    stderr.write(`${explain('body-unreadable', 'the signed body could not be prepared')}\n`);
    return REFUSED_EXIT;
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temporary folder */ } }
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseOwn, readBody, realGhUsable, REFUSED_EXIT, SHIM_MARKER };
