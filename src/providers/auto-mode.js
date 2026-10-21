'use strict';

/**
 * Auto mode for the agent CLIs the package starts (issue #296): by default each CLI is started so that it does not stop to
 * ask for approval of every action. The person chose that default; it can be switched off for everything or for one
 * provider, in the person's own user settings only (the caller reads them with `readUserLevel`).
 *
 * Only flags the provider's official documentation lists are passed. A provider with no documented flag gets none and is
 * shown as unknown, never guessed. Everything here is a REQUEST to the CLI: whether the CLI honours it (for example Claude Code
 * starts in Manual when auto mode is unavailable to the session) is not known to the package.
 *
 * Sources, read 2026-10-21:
 *  - Claude Code: https://code.claude.com/docs/en/cli-reference (`--permission-mode` accepts default, acceptEdits, plan, auto,
 *    dontAsk, bypassPermissions) and https://code.claude.com/docs/en/permission-modes ("auto mode": a classifier model reviews
 *    actions instead of the person; with Claude Code v2.1.283 or later it is the built-in starting mode of interactive sessions;
 *    when it is not available to the session Claude Code starts in Manual instead). `--dangerously-skip-permissions`
 *    (= bypassPermissions, "Isolated containers and VMs only") is NOT used.
 *  - Codex CLI: https://developers.openai.com/codex/cli/reference (redirects to https://learn.chatgpt.com/docs/developer-commands?surface=cli;
 *    no version on the page): `--ask-for-approval, -a` (`on-request | never`, "Control when Codex pauses for human approval
 *    before running a command") and `--sandbox, -s` (`read-only | workspace-write | danger-full-access`). `--yolo` /
 *    `--dangerously-bypass-approvals-and-sandbox` ("Only use inside an externally hardened environment") is NOT used, and
 *    `--full-auto` is not listed on that page, so it is not used either.
 */

const AUTO_MODE_ARGUMENTS = Object.freeze({
  claude: Object.freeze(['--permission-mode', 'auto']),
  codex: Object.freeze(['--sandbox', 'workspace-write', '--ask-for-approval', 'never'])
});

const VALUES = Object.freeze(['on', 'off']);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{ provider: unknown, setting?: unknown, overrides?: unknown }} input
 *   `setting`: the user-level `multiagentSystem.agents.autoMode` (undefined when never set: on). `overrides`: the user-level
 *   `multiagentSystem.agents.autoModeOverrides`, an object of provider id -> 'on' | 'off'.
 * @returns {{ state: 'on' | 'off' | 'unknown', args: string[], label: string }}
 *   `unknown`: auto mode is on but this provider has no documented flag. An unusable setting value is treated as off (the
 *   CLI asks as usual) and said so: a value that cannot be read never makes an agent less careful.
 */
function resolveAutoMode({ provider, setting, overrides } = {}) {
  const id = typeof provider === 'string' ? provider : '';
  let mode = setting === undefined ? 'on' : setting;
  let invalid = !VALUES.includes(mode);
  if (isPlain(overrides) && Object.hasOwn(overrides, id)) {
    mode = overrides[id];
    invalid = !VALUES.includes(mode);
  }
  if (invalid) return { state: 'off', args: [], label: 'Auto mode: off (the setting is not "on" or "off", so the CLI asks for approval as usual)' };
  if (mode === 'off') return { state: 'off', args: [], label: 'Auto mode: off (the CLI asks for approval as usual)' };
  const args = Object.hasOwn(AUTO_MODE_ARGUMENTS, id) ? AUTO_MODE_ARGUMENTS[id] : undefined;
  if (!args) return { state: 'unknown', args: [], label: 'Auto mode: on requested, but this provider has no documented flag, so none was passed (unknown)' };
  return { state: 'on', args: [...args], label: `Auto mode: on (won't ask for each approval) — passed: ${args.join(' ')}` };
}

/**
 * The lines the confirmation window and the toast show. They say what the CLI will not stop to ask, and what that means for
 * the isolation the session runs with.
 * @param {{ state: string, args: string[], label: string }} auto
 * @param {'enforced' | 'advisory'} isolation
 */
function describeAutoMode(auto, isolation) {
  if (!auto || auto.state === 'off') return [auto ? auto.label : 'Auto mode: off'];
  const lines = [auto.label, 'The CLI does not stop to ask for approval of each action; whether it honours the request is not verified.'];
  if (auto.state === 'on' || auto.state === 'unknown') {
    lines.push(isolation === 'enforced'
      ? 'Enforced isolation: the CLI runs inside the sandbox, so its network and credential access are limited as shown.'
      : 'No isolation protects this session: the agent can run commands and write files directly. Enforced isolation (macOS) is recommended with auto mode.');
  }
  lines.push('Switch it off in your user settings: multiagentSystem.agents.autoMode.');
  return lines;
}

module.exports = { AUTO_MODE_ARGUMENTS, resolveAutoMode, describeAutoMode };
