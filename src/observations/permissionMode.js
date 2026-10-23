'use strict';

/**
 * Which permission mode an agent's CLI is really in, against the one it was asked to start in (#362). A Claude Code started with
 * `--permission-mode auto` falls back to asking before actions when auto mode is not available (for the account, the plan or the
 * model), when its classifier cannot be used, or when the conversation has grown too long for the classifier. Until now the card
 * showed only what was asked for. The mode the CLI reports comes from the `permission_mode` field of its own hook events. Pure.
 */

const MODE_WORDS = Object.freeze({
  default: 'default (asks before actions)',
  acceptEdits: 'acceptEdits (edits files without asking, asks before commands)',
  plan: 'plan (only plans, changes nothing)',
  auto: 'auto (a classifier approves actions instead of you)',
  dontAsk: 'dontAsk (does not ask; actions not allowed by the rules are refused)',
  bypassPermissions: 'bypassPermissions (does not ask at all)'
});
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{ provider?: string, requested?: string | null, reported?: { mode: string, since: string } | null }} input
 *   `requested`: 'on' (auto mode asked for), 'off' (ask), 'unknown' or null. `reported`: from the CLI's last hook event.
 * @returns {{ text: string, attention: boolean, lines: string[] } | null} null for a CLI that reports no mode (Codex, agy).
 */
function describePermissionMode({ provider, requested = null, reported = null } = {}) {
  if (provider !== 'claude') return null;
  if (!isPlain(reported) || !Object.hasOwn(MODE_WORDS, reported.mode)) {
    return { text: 'Permission mode: not reported yet (Claude Code reports it with its first action)', attention: false, lines: [] };
  }
  const words = MODE_WORDS[reported.mode];
  if (requested === 'on' && reported.mode !== 'auto') {
    return {
      text: `Auto mode is not in effect: Claude Code reports ${words}`,
      attention: true,
      lines: [
        'Claude Code was started with --permission-mode auto, but it is in another mode now, so the agent stops to ask.',
        'Claude Code does this when auto mode is not available to this account, plan or model, when its classifier cannot be used, or when the conversation has become too long for the classifier.',
        'Next: reopen the session (Stop & Reopen) to start a fresh conversation; if it happens again, check that this account can use auto mode (/permissions in the agent\'s terminal).'
      ]
    };
  }
  return { text: `Permission mode: ${words}, reported by Claude Code`, attention: false, lines: [] };
}

module.exports = { describePermissionMode, MODE_WORDS };
