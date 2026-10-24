'use strict';

/**
 * The Add Account wizard (#352): one path from nothing to an account that shows who it is, its plan and its usage. It asks for a
 * name, says in one confirmation everything it will do, then creates the recommended folder, saves the profile, for Claude Code
 * sets up the status line (usage) and the hook bridge (what the agent is doing) in that folder's own settings, opens the sign-in
 * terminal, and checks the sign-in once the person says they are done or closes the terminal. Every step that fails says why and
 * what to do next; a folder made for an account that could not be saved is removed again.
 *
 * Pure: every effect is a dependency, so each step's success and failure is tested without VS Code.
 */

const PROVIDERS = Object.freeze({
  claude: { label: 'Claude Code', bridges: true },
  codex: { label: 'Codex', bridges: false }
});
const MAX_LABEL = 60;

/** A name the person typed, trimmed, or why it cannot be one. */
function checkLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label === '') return { ok: false, message: 'Enter a name for this account, for example Work or Personal.' };
  if (label.length > MAX_LABEL) return { ok: false, message: `Use at most ${MAX_LABEL} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(label)) return { ok: false, message: 'Use plain text without line breaks or control characters.' };
  return { ok: true, label };
}

/** What the one confirmation says the wizard will do, in order. */
function planLines(provider, label, folder) {
  const info = PROVIDERS[provider];
  return [
    `1. Create the folder ${folder} for “${label}” (outside your project, only for this account's sign-in and settings).`,
    ...(info.bridges ? ['2. Set up the status line (usage: 5h and 7d) and the hook bridge (what each agent is doing) in that folder\'s own settings.json. Your other Claude settings are not touched.'] : []),
    `${info.bridges ? 3 : 2}. Open a terminal that runs the ${info.label} sign-in with this folder.`,
    `${info.bridges ? 4 : 3}. Check the sign-in when you close that terminal or say you are done, and show the account's e-mail, plan and usage.`
  ];
}

/**
 * @param {object} deps
 *   askLabel(): Promise<string|undefined>; confirm(lines): Promise<boolean>; suggest(label): string;
 *   createFolder(label): { ok: true, dir } | { ok: false, message };
 *   createProfile({ label, dir }): { ok: true, profile } | { ok: false, message };
 *   discardFolder(dir): void;
 *   statusLine(profile), hooks(profile): Promise<{ ok: boolean, message?: string }>;
 *   openSignIn(profile): Promise<{ ok: true, done: Promise<void> } | { ok: false, message }>;
 *   check(profile): Promise<{ ok: boolean, state?: string, reason?: string }>;
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, profile?: object, steps: Array<{ step: string, ok: boolean, message?: string, next?: string }> }>}
 */
async function addAccount(provider, deps) {
  const steps = [];
  const fail = (step, message, next) => { steps.push({ step, ok: false, message, next }); return { ok: false, steps }; };
  if (!Object.hasOwn(PROVIDERS, provider)) return fail('provider', 'Only Claude Code and Codex accounts can be added here.', 'Choose Claude Code or Codex.');
  const typed = await deps.askLabel();
  if (typed === undefined) return { ok: false, cancelled: true, steps };
  const name = checkLabel(typed);
  if (!name.ok) return fail('name', name.message, 'Start Add account again with another name.');
  const label = name.label;
  if (!(await deps.confirm(planLines(provider, label, deps.suggest(label))))) return { ok: false, cancelled: true, steps };

  const folder = deps.createFolder(label);
  if (!folder.ok) return fail('folder', folder.message, 'Free the folder name or choose another account name, then start again.');
  steps.push({ step: 'folder', ok: true, message: folder.dir });
  const created = deps.createProfile({ label, dir: folder.dir });
  if (!created.ok) {
    deps.discardFolder(folder.dir);
    return fail('profile', created.message, 'Nothing was kept; start Add account again.');
  }
  const profile = created.profile;
  steps.push({ step: 'profile', ok: true });

  if (PROVIDERS[provider].bridges) {
    // A bridge that could not be set up does not undo the account: the person is told how to set it up later.
    const usage = await deps.statusLine(profile);
    steps.push(usage.ok ? { step: 'status-line', ok: true } : { step: 'status-line', ok: false, message: usage.message ?? 'The status line could not be set up.', next: 'Use “Enable the Claude status line bridge” on the account row.' });
    const state = await deps.hooks(profile);
    steps.push(state.ok ? { step: 'hooks', ok: true } : { step: 'hooks', ok: false, message: state.message ?? 'The hook bridge could not be set up.', next: 'Use “Configure Claude Hook Bridge” on the account.' });
  }

  const signIn = await deps.openSignIn(profile);
  if (!signIn.ok) {
    steps.push({ step: 'sign-in', ok: false, message: signIn.message, next: 'Use “Sign in” on the account row.' });
    return { ok: false, profile, steps };
  }
  steps.push({ step: 'sign-in', ok: true });
  await signIn.done;
  const checked = await deps.check(profile);
  const signedIn = checked && checked.ok === true;
  steps.push(signedIn ? { step: 'check', ok: true } : { step: 'check', ok: false, message: `The sign-in could not be confirmed (${checked && checked.reason ? checked.reason : 'unknown'}).`, next: 'Finish signing in in the terminal, then use “Check sign-in” on the account row.' });
  return { ok: signedIn, profile, steps };
}

/** One message for the person about how the wizard ended. */
function summarize(provider, label, result) {
  if (result.cancelled) return null;
  const failed = result.steps.filter((step) => !step.ok);
  if (failed.length === 0) return { level: 'info', text: `“${label}” is ready: signed in${PROVIDERS[provider]?.bridges ? ', with usage and agent state set up' : ''}.` };
  return { level: result.profile ? 'warning' : 'error', text: failed.map((step) => `${step.message} Next: ${step.next}`).join(' ') };
}

module.exports = { addAccount, checkLabel, planLines, summarize, PROVIDERS, MAX_LABEL };
