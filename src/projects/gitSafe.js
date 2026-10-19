'use strict';

/**
 * Arguments that make read-only Git commands safe to run inside a repository someone else configured.
 * Git runs a repository's own commands in a few places while it only looks: a file monitor
 * (core.fsmonitor) and the content filters named in .gitattributes (filter.<name>.clean, .smudge,
 * .process), which `git diff` and sometimes `git status` run to compare files. Both are switched off here.
 * Filters cannot be listed in advance, so they are read from the configuration (reading it runs nothing)
 * and each one that the repository (not the person running the extension) configured is emptied for the call.
 * A filter name that cannot be passed safely makes the call refuse.
 */

const BASE = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']);
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
// Where a setting comes from. System and user (global) configuration belong to the person running the
// extension: a filter they installed themselves (Git LFS, for example) is theirs and keeps working, because
// emptying it would make every file it manages look changed. The repository's own configuration, a
// worktree's and anything given on the command line come from whoever made the repository.
const UNTRUSTED_SCOPES = new Set(['local', 'worktree', 'command']);

/** @param {(args: string[]) => Promise<string>} run runs `git <args>` in the folder to inspect */
async function safeArgs(run) {
  let listed = '';
  try {
    listed = await run([...BASE, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.']);
  } catch (error) {
    // `config --get-regexp` exits 1 when nothing matches: that is "no filters", not a failure.
    const code = error && error.cause && error.cause.code !== undefined ? error.cause.code : error && error.code;
    if (code !== 1) throw error;
  }
  const names = new Set();
  for (const row of listed.split(/\r?\n/).filter(Boolean)) {
    const split = row.search(/\s/);
    const scope = split < 0 ? '' : row.slice(0, split);
    const key = split < 0 ? row : row.slice(split).trim();
    const match = FILTER_KEY.exec(key);
    if (!match || !UNTRUSTED_SCOPES.has(scope)) continue;
    if (!NAME.test(match[1])) throw Object.assign(new Error('filter-name-unsafe'), { code: 'filter-name-unsafe' });
    names.add(match[1]);
  }
  const overrides = [];
  for (const name of [...names].sort()) {
    for (const key of ['clean', 'smudge', 'process']) overrides.push('-c', `filter.${name}.${key}=`);
    overrides.push('-c', `filter.${name}.required=false`);
  }
  return [...BASE, ...overrides];
}

module.exports = { safeArgs, BASE, UNTRUSTED_SCOPES };
