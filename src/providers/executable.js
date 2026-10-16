'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;

/**
 * A preflight for a built-in CLI name. Only the host process PATH is inspected; neither a
 * workspace file nor a CLI login/configuration folder participates. This proves that an
 * executable is present now, not that it will authenticate or that the terminal ran it.
 */
function executableAvailable(name, { env = process.env, platform = process.platform, stat = fs.statSync, access = fs.accessSync } = {}) {
  if (typeof name !== 'string' || !NAME.test(name) || !env || typeof env !== 'object') return false;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const rawPath = pathKey && env[pathKey];
  if (typeof rawPath !== 'string') return false;
  const suffixes = platform === 'win32'
    ? (typeof env.PATHEXT === 'string' ? env.PATHEXT.split(';').filter((part) => SAFE_EXTENSION.test(part)) : ['.COM', '.EXE', '.BAT', '.CMD'])
    : [''];
  // An empty or relative PATH entry can mean the active repository. Ignore it so a workspace
  // cannot satisfy the preflight by dropping a same-named executable beside project files.
  for (const directory of rawPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const target = path.join(directory, `${name}${suffix}`);
      try {
        if (!stat(target).isFile()) continue;
        access(target, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return false;
}

module.exports = { executableAvailable };
