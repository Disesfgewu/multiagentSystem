'use strict';

const path = require('node:path');

/**
 * The macOS building blocks for the managed-isolation interface (issue #25; the shared interface is
 * `capabilities.js`): the Seatbelt profile builder and the environment scrubber. The verification harness that tries
 * every bypass channel for real (with synthetic credentials and local stand-in endpoints) is test code:
 * `test/isolation/macos-harness.js`. It is not shipped in the extension package, because its fixtures are exactly
 * the shapes the publication scan must refuse to let through.
 *
 * Mechanism: the Seatbelt sandbox through `/usr/bin/sandbox-exec`. Apple marks that command deprecated; it is what
 * the system offers for running one process under a profile, not a promise that it stays. Seatbelt can filter the
 * network only by address and port, not by host name, so a profile cannot say "GitHub but not the model provider".
 * This module therefore proves the mechanism with one allowed local port (standing in for a filtering proxy that is
 * not built here) and everything else denied. It does not test a real CLI, a real GitHub credential, the system
 * keychain, or a real remote.
 *
 * What counts as a result is observed, not inferred from an exit code: a bypass is "open" only when the stand-in
 * server saw a connection, or the synthetic secret came back, or the commit appeared. Each attempt is run twice,
 * the same way, once inside the sandbox and once outside as the control; a control that could not succeed (for
 * example `gh` is not installed) makes the channel unknown, never blocked.
 */

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Only plain absolute, normalized paths without characters that could end or change a profile string. */
function safeProfilePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (!path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) return false;
  // Quotes, backslashes and parentheses are profile syntax; control, bidirectional and separator characters hide text.
  return !/["\\()\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value);
}

/**
 * Text of a Seatbelt profile that allows everything except: all network access (apart from the listed local ports),
 * reading under `denyRead`, and writing under `denyWrite`. Throws on any value that is not a safe path or a port, so
 * a bad input can never produce a profile that is more open than the caller asked for.
 * @param {{ denyRead?: string[], denyWrite?: string[], allowLocalPorts?: number[] }} spec
 */
// The system service that hands out keychain items. `git-credential-osxkeychain` and `security` ask it, so refusing the file
// reads under ~/Library/Keychains does not stop them: the lookup of this service has to be refused too.
const KEYCHAIN_SERVICES = Object.freeze(['com.apple.SecurityServer']);
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function seatbeltProfile({ denyRead = [], denyWrite = [], allowLocalPorts = [], denyMachServices = [] } = {}) {
  for (const list of [denyRead, denyWrite]) {
    if (!Array.isArray(list) || !list.every(safeProfilePath)) throw Object.assign(new Error('isolation-profile-path-invalid'), { code: 'isolation-profile-path-invalid' });
  }
  if (!Array.isArray(allowLocalPorts) || !allowLocalPorts.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw Object.assign(new Error('isolation-profile-port-invalid'), { code: 'isolation-profile-port-invalid' });
  }
  if (!Array.isArray(denyMachServices) || !denyMachServices.every((name) => typeof name === 'string' && SERVICE_NAME.test(name))) {
    throw Object.assign(new Error('isolation-profile-service-invalid'), { code: 'isolation-profile-service-invalid' });
  }
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    ...allowLocalPorts.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    ...denyRead.map((target) => `(deny file-read* (subpath "${target}"))`),
    ...denyWrite.map((target) => `(deny file-write* (subpath "${target}"))`),
    ...denyMachServices.map((name) => `(deny mach-lookup (global-name "${name}"))`),
    ''
  ].join('\n');
}

const { scrubEnvironment } = require('./environment');

// Where a person's own GitHub and git credentials live under their home folder. A profile that is meant to keep an
// agent from them must deny reading all of these, not only the synthetic files a test plants.
const HOME_CREDENTIAL_PATHS = Object.freeze(['.git-credentials', '.config/git/credentials', '.config/gh', '.netrc', '.ssh', 'Library/Keychains']);

/** The credential locations under `home`, as absolute paths ready for `denyRead`. Throws on a home that is not a safe path. */
function credentialLocations(home) {
  if (!safeProfilePath(home)) throw Object.assign(new Error('isolation-profile-path-invalid'), { code: 'isolation-profile-path-invalid' });
  return HOME_CREDENTIAL_PATHS.map((relative) => path.posix.join(home, relative));
}

module.exports = { KEYCHAIN_SERVICES, credentialLocations, HOME_CREDENTIAL_PATHS, seatbeltProfile, scrubEnvironment, safeProfilePath, SANDBOX_EXEC };
