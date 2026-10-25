'use strict';

/**
 * The #360 items, as the owner reaches them: only mouse clicks and keys on what is on the screen (the command palette is the
 * keyboard's way in). Each step says what it does (`does`, used in REPORT.md and the user guide) and checks text on the screen.
 * New items are added by the PR that builds them (#361: "every user-facing PR adds its own steps"). An item is `acceptance: 'accepted'`
 * only when its steps check exactly what #360 asks the owner to see; until then it is `not-done` with what is still `pending`.
 */

const COMMAND_PALETTE = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';

/**
 * Runs one action and, when it took longer than a second, prints how long and what it waited for (#380 review): a run that is slow
 * or stuck then says where. `what` names the selector or the window.
 */
async function timed(what, action, limitMs = 20000) {
  const started = Date.now();
  // What the run last started or finished, for the step's heartbeat (report.js): even a wait outside timed() is placed by it.
  globalThis.e2eLastAction = `started: ${what}`;
  // Said while it is still waiting too: an action that never finishes would otherwise say nothing at all.
  const still = setInterval(() => console.log(`e2e:   still waiting for ${what} after ${Math.round((Date.now() - started) / 1000)} s`), 10000);
  let timer;
  try {
    // And it has a limit of its own (#385): past it, it fails with its name instead of holding the step.
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish in ${limitMs / 1000} s`)), limitMs); })
    ]);
  } finally {
    clearInterval(still);
    clearTimeout(timer);
    globalThis.e2eLastAction = `finished: ${what}`;
    const took = Date.now() - started;
    if (took > 1000) console.log(`e2e:   ${(took / 1000).toFixed(1)} s waiting for ${what}`);
  }
}

/** A pause on this side's clock, not the page's: it ends even when the page does not answer (#385). */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Presses Enter in a list or input box (#385). Enter that accepts a choice can open a webview at once, which takes the focus into a
 * frame of its own; the key's acknowledgment then may never come back, so the press never resolves, though the key did its work
 * (CI run 40119192971: the Issue page was open behind a press that never finished). The press is given three seconds; after that the
 * flow goes on, and what the key did is checked by the flow's own end condition, as before.
 */
async function pressEnter(page) {
  let acknowledged = false;
  const press = page.keyboard.press('Enter').then(() => { acknowledged = true; }, () => { acknowledged = true; });
  await timed('pressing Enter', () => Promise.race([press, pause(3000)]));
  if (!acknowledged) console.log('e2e:   Enter was not acknowledged within 3 s (the focus moved into a new webview); going on and checking what it did');
}

/** A frame that does not answer (a webview in the background) is skipped: what it was asked counts as `fallback` after 3 s. */
function bounded(promise, fallback, ms = 3000) {
  let timer;
  return Promise.race([promise.catch(() => fallback), new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]).finally(() => clearTimeout(timer));
}

/** Runs a command the way a person does: open the command palette, type its title, press Enter. */
async function runCommand(page, title) {
  await page.keyboard.press(COMMAND_PALETTE);
  const input = page.locator('.quick-input-widget .quick-input-box input').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(`>${title}`);
  await page.locator('.quick-input-widget .quick-input-list .monaco-list-row', { hasText: title }).first().waitFor({ timeout: 10000 });
  await pressEnter(page);
}

/** Closes the notifications in the corner (as a person would), so a screenshot shows the screen itself. */
async function clearNotifications(page) {
  await runCommand(page, 'Notifications: Clear All Notifications');
  await pause(300);
}

/** The text of the webview whose tab title is `title` (VS Code puts a webview in two nested frames). */
async function webviewText(page, title, wait) {
  const deadline = Date.now() + 30000;
  let text = '';
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.url().includes('fake.html') && !frame.url().includes('index.html')) continue;
      try { text = await frame.locator('body').innerText({ timeout: 1000 }); } catch { continue; }
      if (wait(text)) return text;
    }
    await pause(250);
  }
  return text;
}

/**
 * Answers the windows a flow opens, the way a person would, until `done()` says the flow is over: a list (quick pick) by typing the
 * entry and pressing Enter, an input box by typing, a modal dialog by clicking its button. `answers` match the list's placeholder,
 * the input box's prompt or the dialog's message; a window nobody answers for fails the step, naming it. `done(seen)` is given
 * what was answered so far.
 */
async function drive(page, answers, done, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  let shots = 0;
  while (Date.now() < deadline) {
    if (await timed('the flow to be done', () => done(seen))) return seen;
    // Every wait below is timed and limited (#385): one that does not end says which it is, and fails the step.
    const dialog = page.locator('.monaco-dialog-box:visible').first();
    if (await timed('a dialog (.monaco-dialog-box)', () => dialog.isVisible().catch(() => false))) {
      // VS Code shows a modal's message in its detail part when the call gives no detail: read the message, else that part.
      // Only a part that is there is read, and briefly: the empty dialog box VS Code leaves behind has neither, and waiting for one
      // would hold every round of this loop for the whole default timeout.
      const textOf = async (selector) => {
        const part = dialog.locator(selector).first();
        if ((await part.count().catch(() => 0)) === 0) return '';
        return (await part.innerText({ timeout: 1000 }).catch(() => '')).trim();
      };
      const message = await timed('the dialog\'s text (.dialog-message-text, .dialog-message-detail)', async () => (await textOf('.dialog-message-text')) || (await textOf('.dialog-message-detail')));
      // A dialog whose text is not drawn yet is looked at again on the next round.
      if (message !== '') {
        const rule = answers.find((entry) => entry.dialog && entry.dialog.test(message));
        if (!rule) throw new Error(`a dialog nobody answers: "${message}"`);
        seen.push(`dialog: ${message} → ${rule.button}`);
        await timed(`clicking "${rule.button}" in the dialog`, () => dialog.locator('.monaco-button', { hasText: rule.button }).first().click());
        await pause(400);
        continue;
      }
    }
    // A notification with a button the flow waits for (for example "I have signed in — check now").
    const toastRule = answers.find((entry) => entry.toast);
    if (toastRule) {
      const toast = page.locator('.notification-toast-container:visible', { hasText: toastRule.toast }).first();
      if (await timed(`a notification "${toastRule.toast}"`, () => toast.isVisible().catch(() => false))) {
        seen.push(`toast: ${toastRule.toast} → ${toastRule.button}`);
        await timed(`clicking "${toastRule.button}" in the notification`, () => toast.locator('.monaco-button', { hasText: toastRule.button }).first().click());
        await pause(400);
        continue;
      }
    }
    const widget = page.locator('.quick-input-widget:visible').first();
    if (await timed('a list or input box (.quick-input-widget)', () => widget.isVisible().catch(() => false))) {
      const input = widget.locator('.quick-input-box input').first();
      const placeholder = (await timed('the list\'s placeholder', () => input.getAttribute('placeholder').catch(() => ''))) ?? '';
      const message = (await timed('the list\'s message (.quick-input-message)', () => widget.locator('.quick-input-message').innerText({ timeout: 2000 }).catch(() => ''))).trim();
      const title = `${placeholder} ${message}`.trim();
      const rule = answers.find((entry) => (entry.pick || entry.toggle || entry.accept || entry.type !== undefined) && entry.when.test(title));
      // The window may be the one the flow waits for, shown just after `done` was asked: ask again before failing.
      if (!rule && await timed('the flow to be done', () => done(seen))) return seen;
      if (!rule) throw new Error(`a window nobody answers: "${title}"`);
      if (rule.toggle) {
        // A list with check boxes: tick this one row, as a person clicks it, then accept.
        const row = widget.locator('.quick-input-list .monaco-list-row', { hasText: rule.toggle }).first();
        await timed(`the list row "${rule.toggle}"`, () => row.waitFor({ timeout: 10000 }));
        await timed(`ticking "${rule.toggle}"`, () => row.locator('input[type="checkbox"], .monaco-custom-toggle, .quick-input-list-checkbox').first().click());
        seen.push(`tick: ${title} → ${rule.toggle}`);
      } else if (rule.accept) {
        // A list with check boxes, accepted as it is (the rows already ticked).
        seen.push(`accept: ${title}`);
      } else if (rule.pick) {
        await timed(`typing "${rule.pick}" into the list`, () => input.fill(rule.pick));
        await timed(`the list row "${rule.pick}"`, () => widget.locator('.quick-input-list .monaco-list-row', { hasText: rule.pick }).first().waitFor({ timeout: 10000 }));
        seen.push(`pick: ${title} → ${rule.pick}`);
      } else {
        if (rule.type !== '') await timed(`typing "${rule.type}"`, () => input.fill(rule.type));
        seen.push(`type: ${title} → ${rule.type || '(as suggested)'}`);
      }
      await pressEnter(page);
      await pause(400);
      continue;
    }
    // MULTIAGENT_E2E_DEBUG=1: a screenshot of every wait (at most 20 per flow), to see a window the page cannot reach.
    if (process.env.MULTIAGENT_E2E_DEBUG === '1' && shots < 20) { shots += 1; await timed('a debug screenshot', () => page.screenshot({ path: require('node:path').join(__dirname, '..', '..', 'artifacts', 'e2e', `debug-${Date.now()}.png`) }).catch(() => {})); }
    await pause(250);
  }
  // The last answer may have been given just before the time ran out.
  if (await timed('the flow to be done', () => done(seen))) return seen;
  throw new Error(`the flow did not finish in ${timeoutMs / 1000} s; answered: ${seen.join(' | ')}`);
}

/** The Workbench page's frame (VS Code puts a webview in two nested frames). */
async function workbenchFrame(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const found = await bounded(frame.locator('h1', { hasText: 'Workbench' }).count(), 0);
      if (found > 0) return frame;
    }
    await pause(250);
  }
  throw new Error('the Workbench page did not appear');
}

/** Clicks a button of the Workbench page by its words (opening the Workbench from the side bar first when it is not open). */
async function clickInWorkbench(page, words, { tab } = {}) {
  return timed(`the Workbench button "${words}"${tab ? ` on ${tab}` : ''}`, () => clickInWorkbenchNow(page, words, { tab }));
}
async function clickInWorkbenchNow(page, words, { tab } = {}) {
  const editorTab = page.locator('.tabs-container .tab', { hasText: 'Workbench' }).first();
  if (await timed('the Workbench editor tab (count)', () => page.locator('.tabs-container .tab', { hasText: 'Workbench' }).count()) === 0) {
    await timed('the Multiagent icon', () => page.locator('.activitybar [aria-label^="Multiagent"]').first().click());
    await timed('Open Workbench in the side bar', () => page.locator('.sidebar .monaco-list-row', { hasText: 'Open Workbench' }).first().click());
  } else {
    // An agent's terminal opens in the editor area in front of it: bring the Workbench back, as a person would.
    await timed('the Workbench editor tab', () => editorTab.click());
  }
  const frame = await timed('the Workbench page\'s frame', () => workbenchFrame(page));
  if (tab) await timed(`the Workbench tab "${tab}"`, () => frame.locator('button[role="tab"]', { hasText: tab }).first().click());
  await timed(`clicking "${words}" in the Workbench`, () => frame.locator('button', { hasText: words }).first().click());
}

/** The frame of the Issue or pull request page whose title has `title` (VS Code puts a webview in two nested frames). */
async function pageFrame(page, title) {
  return timed(`the page "${title}"`, () => pageFrameNow(page, title));
}
async function pageFrameNow(page, title) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const found = await bounded(frame.locator('h1', { hasText: title }).count(), 0);
      if (found > 0) return frame;
    }
    await pause(250);
  }
  throw new Error(`the page "${title}" did not appear`);
}

/** Waits until the page's text has not changed for a second (at most 15 s), so a click lands on what was found. */
async function settled(page, frame) {
  const deadline = Date.now() + 15000;
  let last = null;
  let since = Date.now();
  while (Date.now() < deadline) {
    const now = await frame.locator('body').innerText().catch(() => '');
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= 1000) return;
    await pause(200);
  }
}

/** The text of an element, timed and limited (#385), so a read that does not end names its selector. */
const textOf = (locator, what) => timed(what, () => locator.innerText({ timeout: 10000 }));
const textsOf = (locator, what) => timed(what, () => locator.allInnerTexts());

/** Opens an Issue or pull request page from the Work tab, as a person does: the button, then the item in the list. */
async function openGitHubPage(page, number, tabLabel) {
  await clickInWorkbench(page, 'Open Issue or pull request…', { tab: 'Work' });
  return drive(page, [{ when: /Open which Issue or pull request/, pick: `#${number} ` }], async () => (await page.locator('.tabs-container .tab', { hasText: tabLabel }).count()) > 0, 30000);
}

const ACCOUNT = 'Work A';
const SECOND = 'Work B';

/**
 * Add Claude Code account through the wizard, as a person does, until the side bar counts it as signed in (the sign-in terminal
 * opens in front of the Workbench, so the side bar is what stays in view). The Workbench is brought back afterwards.
 */
async function addClaudeAccount(page, name, signedIn) {
  await clickInWorkbench(page, 'Add Claude Code account', { tab: 'Accounts' });
  const counted = new RegExp(`Accounts: ${signedIn} accounts?, ${signedIn} signed in`);
  const answered = await drive(page, [
    { when: /A name for this Claude Code account/, type: name },
    { dialog: /^Add the Claude Code account/, button: 'Add and Sign In' },
    { toast: 'Sign in to Claude Code in the terminal', button: 'I have signed in — check now' }
  ], async () => counted.test(await page.locator('.sidebar').innerText().catch(() => '')), 90000);
  // The Refresh button is on the Agents tab; the Accounts tab then shows what was read.
  await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
  await (await workbenchFrame(page)).locator('button[role="tab"]', { hasText: 'Accounts' }).first().click();
  await pause(1500);
  return answered;
}

const ROLE = 'E2E Developers';
// The codename at the start of a card ("Worker-05 · E2E Agent 5"), and the one the switched agent had before.
const CODENAME = /\b([A-Z][A-Za-z]*-\d{2,4}) · E2E Agent 5/;
const switched = { codename: null };
const CODEX = 'Codex A';

/** The rows of the list (quick pick) on the screen, top first, when its placeholder matches `when`; null when it is not shown. */
async function listRows(page, when) {
  return listRowsNow(page, when);
}

/** Waits until the list whose placeholder matches `when` is on the screen, and returns its rows. */
async function waitForList(page, when, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await listRowsNow(page, when);
    if (rows !== null && rows.length > 0) return rows;
    await pause(250);
  }
  throw new Error(`the list "${when}" did not appear`);
}

async function listRowsNow(page, when) {
  const widget = page.locator('.quick-input-widget:visible').first();
  if (!(await widget.isVisible().catch(() => false))) return null;
  const placeholder = (await widget.locator('.quick-input-box input').first().getAttribute('placeholder').catch(() => '')) ?? '';
  if (!when.test(placeholder)) return null;
  return widget.locator('.quick-input-list .monaco-list-row').allInnerTexts();
}

/** The agents' Claude starts the synthetic CLI recorded so far (not its sign-in or version calls). */
function agentStarts(box) {
  return require('./fakes').readCalls(box.fakes.calls).filter((call) => call.cli === 'claude' && !call.args.includes('auth') && !call.args.includes('--version'));
}

// What the windows of Start agent and Restart ask after the account, answered as a person does.
const START_ANSWERS = [
  { when: /Select a model/, pick: 'Use CLI default model' },
  { dialog: /Account isolation is not verified/, button: 'Continue' },
  { dialog: /auto mode|Auto mode/, button: 'I Understand, Continue' },
  { dialog: /Effective agent instructions prepared/, button: 'Start Agent' },
  { dialog: /usage|quota|limit/i, button: 'Start Anyway' }
];

const ITEMS = [
  {
    id: '00',
    title: 'The Multiagent side bar keeps one entry',
    issue: '#357',
    acceptance: 'accepted',
    steps: [
      {
        name: 'open-side-bar',
        does: 'Click the Multiagent icon in the activity bar.',
        run: async ({ page, check }) => {
          await page.locator('.activitybar [aria-label^="Multiagent"]').first().click();
          await page.locator('.sidebar .monaco-list-row', { hasText: 'Open Workbench' }).first().waitFor({ timeout: 20000 });
          // With one view, VS Code shows only the container's title and no view header: the classic views' names are nowhere.
          const sideBar = await page.locator('.sidebar').innerText();
          check('the side bar is Multiagent', sideBar, /MULTIAGENT/i);
          check('none of the classic views is there', sideBar, (text) => !/OVERVIEW|ISSUES REPORT|PRS REPORT|ACCOUNTS AND SESSIONS|ROLE GROUPS|BROADCASTS|SHARED MEMORY|TOOLS SETUP/i.test(text));
          const rows = await page.locator('.sidebar .monaco-list-row').allInnerTexts();
          check('its first line is Open Workbench', rows[0] ?? '', /Open Workbench/);
          check('then the agents, what needs you and the accounts, one line each', rows.join(' | '), (text) => /Agents: /.test(text) && /Needs you: /.test(text) && /Accounts: /.test(text));
        }
      },
      {
        name: 'open-workbench',
        does: 'Click "Open Workbench" in the side bar.',
        run: async ({ page, check }) => {
          await page.locator('.sidebar .monaco-list-row', { hasText: 'Open Workbench' }).first().click();
          const tab = page.locator('.tabs-container .tab', { hasText: 'Workbench' });
          await tab.first().waitFor({ timeout: 20000 });
          check('the Workbench opens in the editor area', await tab.first().innerText(), /Workbench/);
          const frame = await workbenchFrame(page);
          const tabs = await frame.locator('button[role="tab"]').allInnerTexts();
          check('with its seven tabs', tabs.join(' | '), 'Agents | Work | Accounts | Broadcast | Ask | Knowledge | Setup');
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '01',
    title: 'Sign in to several Claude Code accounts',
    issue: '#352',
    acceptance: 'accepted',
    steps: [
      {
        name: 'add-first-account',
        does: 'In the Workbench, open Accounts and click "Add Claude Code account": type the name "Work A", click "Add and Sign In", sign in in the terminal that opens, then click "I have signed in — check now".',
        run: async ({ page, check }) => {
          const answered = await addClaudeAccount(page, ACCOUNT, 1);
          check('the wizard asked for a name, one confirmation, and the sign-in', answered.join(' | '), /type: [\s\S]*Work A[\s\S]*Add and Sign In[\s\S]*check now/);
          const frame = await workbenchFrame(page);
          check('the account row says which account it is and that it is signed in', await frame.locator('div[data-account]', { hasText: ACCOUNT }).first().innerText(), (text) => /Work A · owner-a@example\.test/.test(text) && /sign-in checked/.test(text));
          await clearNotifications(page);
        }
      },
      {
        name: 'add-second-account',
        does: 'Do the same for a second account, "Work B".',
        run: async ({ page, check }) => {
          await addClaudeAccount(page, SECOND, 2);
          const frame = await workbenchFrame(page);
          const rows = await frame.locator('div[data-account]').allInnerTexts();
          check('two accounts, each with its own e-mail address', rows.join(' | '), (text) => /Work A · owner-a@example\.test/.test(text) && /Work B · owner-b@example\.test/.test(text));
          check('neither is the same real account as the other', rows.join(' | '), (text) => !/same real account|DUPLICATE/i.test(text));
          check('the side bar says both are signed in', await page.locator('.sidebar').innerText(), /Accounts: 2 accounts, 2 signed in/);
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '11',
    title: 'One screen with every agent working on this project',
    issue: '#357 (Agents tab), #368',
    acceptance: 'accepted',
    steps: [
      {
        name: 'create-role-group',
        does: 'Open the Agents tab and click "Create role group…": choose the Developer template, Claude Code and the name "E2E Developers", then "Create Role Group".',
        run: async ({ page, check }) => {
          await clickInWorkbench(page, 'Create role group…', { tab: 'Agents' });
          const answered = await drive(page, [
            { when: /Start from a template/, pick: 'Developer' },
            { when: /Which command-line agent runs this role/, pick: 'Claude Code' },
            { when: /A label you will recognise/, type: ROLE },
            { dialog: /^Create role group/, button: 'Create Role Group' }
          ], async (seen) => seen.some((line) => /Create Role Group/.test(line)) && !(await page.locator('.monaco-dialog-box:visible').first().isVisible().catch(() => false)), 60000);
          check('the role group was created after its confirmation', answered.join(' | '), /Create Role Group/);
          await clearNotifications(page);
        }
      },
      {
        name: 'start-four-agents',
        does: 'Click "Start agent…" four times: Claude Code, the account "Work A", the role group "E2E Developers", the CLI default model; confirm the windows that ask.',
        run: async ({ page, check, box }) => {
          for (let index = 1; index <= 4; index += 1) {
            await clickInWorkbench(page, 'Start agent…', { tab: 'Agents' });
            await drive(page, [
              { when: /Choose the CLI to run in a native terminal/, pick: 'Claude Code' },
              { when: /Terminal name/, type: `E2E Agent ${index}` },
              { when: /Choose an account for this new session/, pick: ACCOUNT },
              { when: /Choose a role group for this agent/, pick: ROLE },
              { when: /Select a model/, pick: 'Use CLI default model' },
              { dialog: /Account isolation is not verified/, button: 'Continue' },
              { dialog: /auto mode|Auto mode/, button: 'I Understand, Continue' },
              { dialog: /Effective agent instructions prepared/, button: 'Start Agent' },
              { dialog: /usage|quota|limit/i, button: 'Start Anyway' }
            ], async () => require('./fakes').readCalls(box.fakes.calls).filter((call) => call.cli === 'claude' && !call.args.includes('auth') && !call.args.includes('--version')).length >= index, 90000);
          }
          const calls = require('./fakes').readCalls(box.fakes.calls).filter((call) => call.cli === 'claude' && !call.args.includes('auth') && !call.args.includes('--version'));
          check('the synthetic claude was started four times, each with the account folder', calls.filter((call) => call.configDir).length, 4);
          // The agent's terminal shows one short line, not the long command typed into it.
          const terminal = await page.locator('.terminal-wrapper.active .xterm-rows, .xterm-rows').last().innerText().catch(() => '');
          check('the terminal says which agent starts', terminal, /Multiagent: starting Claude Code \(Worker-0\d\)/);
          check('and does not show the long command', terminal, (text) => !/--settings|--append-system-prompt-file|PATH=/.test(text));
          await clearNotifications(page);
        }
      },
      {
        name: 'see-four-cards',
        does: 'Look at the Agents tab of the Workbench.',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'Workbench' }).first().click();
          const frame = await workbenchFrame(page);
          await frame.locator('button[role="tab"]', { hasText: 'Agents' }).first().click();
          // The last agent started reports its state through its hooks a moment later (#378): wait, with a limit, until every card has.
          const deadline = Date.now() + 30000;
          let text = '';
          while (Date.now() < deadline) {
            text = await frame.locator('body').innerText();
            const waiting = (await frame.locator('section[data-id]').allInnerTexts()).filter((card) => /E2E Agent/.test(card) && /waiting for input/.test(card));
            if (/Agents \(4\)/.test(text) && waiting.length === 4) break;
            await pause(500);
          }
          check('four agent cards', text, /Agents \(4\)/);
          const cards = await frame.locator('section[data-id]').allInnerTexts();
          const agentCards = cards.filter((card) => /E2E Agent/.test(card));
          check('each card is one of the four agents', agentCards.length, 4);
          check('each card shows its codename', agentCards.every((card) => /\b[A-Z][A-Za-z]*-\d{2,4}\b/.test(card)), true);
          check('each card shows its account with its e-mail address', agentCards.every((card) => card.includes('Account: Work A (owner-a@example.test)')), true);
          check('each card shows its mode in one word', agentCards.every((card) => /Mode: Auto/.test(card)), true);
          check('each card says what the agent is doing, from its own hooks', agentCards.every((card) => /waiting for input/.test(card)), true);
          check('each card is plain: the worktree and evidence are under Details', agentCards.every((card) => !/upstream|hook evidence|Prepared for this agent/.test(card)), true);
          check('VS Code not connected is a small tag, not a paragraph', agentCards.every((card) => /VS Code not connected/.test(card) && !/no VS Code window has registered/.test(card)), true);
          const view = page.viewportSize() ?? { width: 1440, height: 900 };
          const frameBox = await page.locator('iframe').last().boundingBox();
          const boxes = await frame.locator('section[data-id]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().bottom));
          check('all four cards fit on one screen', Boolean(frameBox) && boxes.length >= 4 && boxes.slice(0, 4).every((bottom) => frameBox.y + bottom <= view.height), true);
          const heading = await frame.locator('main h2', { hasText: 'Agents (4)' }).first().boundingBox();
          const first = await frame.locator('section[data-id]').first().boundingBox();
          check('the cards sit under the "Agents (4)" heading, not in a column beside it', Boolean(heading && first && first.y > heading.y && Math.abs(first.x - heading.x) < 40), true);
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '02',
    title: 'Each account\'s usage and plan',
    issue: '#352',
    acceptance: 'accepted',
    steps: [
      {
        name: 'see-usage',
        does: 'After agents have run on "Work A", open the Accounts tab of the Workbench.',
        run: async ({ page, check }) => {
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          await frame.locator('button[role="tab"]', { hasText: 'Accounts' }).first().click();
          const row = frame.locator('div[data-account]', { hasText: ACCOUNT }).first();
          const deadline = Date.now() + 30000;
          let text = '';
          while (Date.now() < deadline) { text = await row.innerText().catch(() => ''); if (/32%/.test(text)) break; await pause(500); }
          check('the 5-hour usage with its reset', text, /5-hour: 32% used[\s\S]*resets in 2h/);
          check('the weekly usage', text, /Weekly: 10% used/);
          check('the weekly Opus usage too', text, /Weekly \(Opus\): 5% used/);
          check('the account it is', text, /Work A · owner-a@example\.test/);
          check('its plan', text, /plan Max/);
          const other = await frame.locator('div[data-account]', { hasText: SECOND }).first().innerText();
          check('an account no agent has run on yet says why it has no usage and what to do', other, /no agent has run|start one|Readings arrive only while a Claude session runs/i);
          // The usage line is plain words; how it was read and where from is under the row's Details (#352).
          const lines = await row.locator('.quota-line').allInnerTexts();
          check('the usage line says only how much is used and when it resets', lines.join(' | '), (value) => /5-hour: 32% used, resets in 2h/.test(value) && !/ from |verified|read \d|read under/.test(value));
          await row.locator('summary', { hasText: 'Details' }).first().click();
          check('where the number comes from is under Details', await row.locator('details').first().innerText(), /5-hour: [^·]+ · read [^·]+ · from claude status line rate_limits/);
          await clearNotifications(page);
        }
      },
      {
        name: 'keep-own-status-line',
        does: 'The account "Work B" already has a status line of its own in its settings.json. On its row, click "Review the status line setting", read what would be replaced, and click "Cancel".',
        run: async ({ page, check, box }) => {
          // The person's own status line, set before Multiagent was asked to set up its own.
          const folder = require('./fakes').readCalls(box.fakes.calls).map((call) => call.configDir).find((dir) => dir && /work-b/i.test(require('node:path').basename(dir)));
          const settingsPath = require('node:path').join(folder, 'settings.json');
          const settings = JSON.parse(require('node:fs').readFileSync(settingsPath, 'utf8'));
          settings.statusLine = { type: 'command', command: 'echo my own status line' };
          const before = JSON.stringify(settings, null, 2);
          require('node:fs').writeFileSync(settingsPath, before);
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          await frame.locator('button[role="tab"]', { hasText: 'Accounts' }).first().click();
          const row = frame.locator('div[data-account]', { hasText: SECOND }).first();
          const deadline = Date.now() + 30000;
          let text = '';
          while (Date.now() < deadline) { text = await row.innerText().catch(() => ''); if (/Review the status line setting/.test(text)) break; await pause(500); }
          check('the row says another status line is set and what to do', text, /another status line|usage bridge not active/i);
          await row.locator('button', { hasText: 'Review the status line setting' }).first().click();
          const answered = await drive(page, [{ dialog: /^Overwrite existing statusLine in “Work B”/, button: 'Cancel' }], async (seen) => seen.length > 0 && !(await page.locator('.monaco-dialog-box:visible').first().isVisible().catch(() => false)), 30000);
          check('it asks before replacing, showing the status line it would replace', answered.join(' | '), /Overwrite existing statusLine in “Work B”[\s\S]*Cancel/);
          const toast = await page.locator('.notification-toast-container').allInnerTexts().catch(() => []);
          check('after Cancel it says nothing was changed', toast.join(' | '), /Existing settings were not changed/);
          check('the account\'s own status line is kept, byte for byte', require('node:fs').readFileSync(settingsPath, 'utf8'), before);
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '03',
    title: 'Which account each agent uses; several Claude Code and Codex accounts',
    issue: '#352',
    acceptance: 'accepted',
    steps: [
      {
        name: 'add-codex-account',
        does: 'In the Accounts tab click "Add Codex account": type the name "Codex A", click "Add and Sign In", sign in in the terminal that opens, then click "I have signed in — check now".',
        run: async ({ page, check }) => {
          await clickInWorkbench(page, 'Add Codex account', { tab: 'Accounts' });
          const answered = await drive(page, [
            { when: /A name for this Codex account/, type: CODEX },
            { dialog: /^Add the Codex account/, button: 'Add and Sign In' },
            { toast: 'Sign in to Codex in the terminal', button: 'I have signed in — check now' }
          ], async () => /Accounts: 3 accounts, 3 signed in/.test(await page.locator('.sidebar').innerText().catch(() => '')), 90000);
          check('the wizard asked for a name, one confirmation, and the sign-in', answered.join(' | '), /Codex A[\s\S]*Add and Sign In[\s\S]*check now/);
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          await frame.locator('button[role="tab"]', { hasText: 'Accounts' }).first().click();
          const row = await frame.locator('div[data-account]', { hasText: CODEX }).first().innerText();
          check('the Codex row says which account it is, from Codex itself', row, /Codex A · codex-owner@example\.test/);
          check('and its plan', row, /plan Plus/);
          check('and that its sign-in was checked', row, /sign-in checked/);
          await clearNotifications(page);
        }
      },
      {
        name: 'set-default-account',
        does: 'In the Agents tab click "Edit role group…": choose "E2E Developers", "Set default account profile", then "Work B".',
        run: async ({ page, check }) => {
          await clickInWorkbench(page, 'Edit role group…', { tab: 'Agents' });
          const said = /now has the default account “Work B”/;
          await drive(page, [
            { when: /Choose a role group/, pick: ROLE },
            { when: /^Edit E2E Developers/, pick: 'Set default account profile' },
            { when: /Running sessions keep their original account/, pick: SECOND }
          ], async () => said.test((await page.locator('.notification-toast-container').allInnerTexts().catch(() => [])).join(' ')), 30000);
          const toast = (await page.locator('.notification-toast-container').allInnerTexts()).join(' | ');
          check('it says what the default account changes', toast, /“E2E Developers” now has the default account “Work B”: Start agent lists it first, and you can still choose another/);
          await clearNotifications(page);
        }
      },
      {
        name: 'see-default-first',
        does: 'Click "Start agent…": Claude Code, the name "E2E Agent 5", the role group "E2E Developers". Look at the account list.',
        run: async ({ page, check }) => {
          await clickInWorkbench(page, 'Start agent…', { tab: 'Agents' });
          let rows = null;
          await drive(page, [
            { when: /Choose the CLI to run in a native terminal/, pick: 'Claude Code' },
            { when: /Terminal name/, type: 'E2E Agent 5' },
            { when: /Choose a role group for this agent/, pick: ROLE }
          ], async () => (rows = await listRows(page, /Choose an account for this new session/)) !== null && rows.length > 0, 60000);
          check('the role group\'s default account is first, and says so', rows[0] ?? '', /Work B[\s\S]*this role group's default account[\s\S]*owner-b@example\.test/);
          check('the other account can still be chosen', rows.slice(1).join(' | '), /Work A/);
          // The list stays open: the picture shows it, and the next step chooses from it.
        }
      },
      {
        name: 'start-with-default',
        does: 'Choose "Work B" and confirm the windows that ask.',
        run: async ({ page, check, box }) => {
          const before = agentStarts(box).length;
          await drive(page, [{ when: /Choose an account for this new session/, pick: SECOND }, ...START_ANSWERS], async () => agentStarts(box).length > before, 90000);
          const started = agentStarts(box).at(-1);
          check('the agent was started with the account folder of "Work B"', require('node:path').basename(started.configDir), /work-b/i);
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          const card = frame.locator('section[data-id]', { hasText: 'E2E Agent 5' }).first();
          await card.waitFor({ timeout: 30000 });
          check('its card says it uses "Work B"', await card.innerText(), /Account: Work B \(owner-b@example\.test\)/);
          await clearNotifications(page);
        }
      },
      {
        name: 'confirm-switch',
        does: 'On the card of "E2E Agent 5" (account "Work B") click "Switch account…", choose "Work A", and read the window that asks before anything stops.',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'Workbench' }).first().click();
          const frame = await workbenchFrame(page);
          await frame.locator('button[role="tab"]', { hasText: 'Agents' }).first().click();
          const card = frame.locator('section[data-id]', { hasText: 'E2E Agent 5' }).first();
          const text = await card.innerText();
          check('the card uses "Work B" before the switch', text, /Account: Work B \(owner-b@example\.test\)/);
          switched.codename = (CODENAME.exec(text) ?? [])[1] ?? null;
          check('and has a codename', switched.codename, (value) => typeof value === 'string');
          await card.locator('button', { hasText: 'Switch account…' }).first().click();
          const rows = await waitForList(page, /Restart “E2E Agent 5” with which account/);
          check('the list offers the other accounts, not the one it uses', rows.join(' | '), (value) => /Work A/.test(value) && !/Work B/.test(value));
          await drive(page, [{ when: /Restart “E2E Agent 5” with which account/, pick: ACCOUNT }], async (seen) => seen.length > 0, 30000);
          const dialog = page.locator('.monaco-dialog-box', { hasText: 'Restart “E2E Agent 5” with the account “Work A”?' }).first();
          await dialog.waitFor({ state: 'visible', timeout: 30000 });
          check('it asks first, in a window of its own, saying what happens', await dialog.innerText(), (value) => /Restart “E2E Agent 5” with the account “Work A”\?/.test(value) && /same folder/.test(value) && /Restart with This Account/.test(value));
          // The window stays open: the picture shows it over the card that still says "Work B"; the next step answers it.
        }
      },
      {
        name: 'switch-account',
        does: 'Click "Restart with This Account".',
        run: async ({ page, check, box }) => {
          const before = agentStarts(box).length;
          const answered = await drive(page, [
            { dialog: /^Restart “E2E Agent 5” with the account “Work A”/, button: 'Restart with This Account' },
            ...START_ANSWERS
          ], async () => agentStarts(box).length > before, 90000);
          check('the agent restarted after the confirmation', answered[0] ?? '', /dialog: Restart “E2E Agent 5” with the account “Work A”\? → Restart with This Account/);
          check('with the account folder of "Work A"', require('node:path').basename(agentStarts(box).at(-1).configDir), (name) => !/work-b/i.test(name));
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const again = await workbenchFrame(page);
          const deadline = Date.now() + 30000;
          let cards = [];
          while (Date.now() < deadline) {
            cards = (await again.locator('section[data-id]').allInnerTexts()).filter((card) => /E2E Agent 5/.test(card));
            if (cards.length === 1 && /Account: Work A/.test(cards[0])) break;
            await pause(500);
          }
          check('one card for it, now with "Work A"', cards.length === 1 && /Account: Work A \(owner-a@example\.test\)/.test(cards[0]), true);
          check('it keeps its codename, so its GitHub signature does not change', (CODENAME.exec(cards[0] ?? '') ?? [])[1] ?? null, switched.codename);
          // The Workbench draws its cards again when an agent reports: find the card again if it was redrawn under the scroll.
          for (let tries = 0; tries < 5; tries += 1) {
            try { await again.locator('section[data-id]', { hasText: 'E2E Agent 5' }).first().scrollIntoViewIfNeeded({ timeout: 5000 }); break; } catch { await pause(500); }
          }
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '08',
    title: 'Issues and pull requests shown like GitHub',
    issue: '#353',
    acceptance: 'accepted',
    steps: [
      {
        name: 'open-issue-page',
        does: 'In the Workbench, open Work and click "Open Issue or pull request…", then choose "#12 Show Issues and pull requests like GitHub".',
        run: async ({ page, check }) => {
          const answered = await openGitHubPage(page, 12, 'Issue #12');
          check('the list offered the Issue', answered.join(' | '), /#12/);
          const frame = await pageFrame(page, 'Show Issues and pull requests like GitHub');
          check('the page opened as an editor tab', await timed('the Issue #12 tab', () => page.locator('.tabs-container .tab', { hasText: 'Issue #12' }).count()), 1);
          check('its state and labels', await textOf(frame.locator('.meta'), 'the page\'s state line (.meta)'), (text) => /open/.test(text) && /ready/.test(text) && /ui/.test(text));
          check('a Markdown heading is a heading', await textOf(frame.locator('.md h2').first(), '.md h2'), 'What the owner sees');
          check('bold and inline code are drawn', await textOf(frame.locator('.md strong').first(), '.md strong'), 'as GitHub shows them');
          check('a task list', (await textsOf(frame.locator('.md li.task'), 'the task list (.md li.task)')).join(' | '), (text) => /☑\s*headings and lists/.test(text) && /☐\s*comments from the page/.test(text));
          check('a table', (await textsOf(frame.locator('.md table td'), 'the table cells (.md table td)')).join(' | '), 'code | a block | link | opens in the browser');
          check('a code block', await textOf(frame.locator('.md pre code').first(), '.md pre code'), "const page = open('#12');");
          check('a link, opened only in the browser', await textOf(frame.locator('.md .md-link').first(), '.md .md-link'), 'the design notes');
          const badges = await textsOf(frame.locator('.post-head .author'), 'the post badges');
          check('every post has the extension\'s badge for who wrote it', badges.join(' | '), 'PM-01（自稱） | Worker-01（自稱） | 未署名 | 未署名');
          const fake = frame.locator('.post', { hasText: 'Approve' }).first();
          check('a post that types a 管理者 badge and a button shows them as text', await textOf(fake.locator('.md'), 'the forged post\'s content (.post .md)'), /<span class="author author-owner">管理者<\/span> <button>Approve<\/button> Pass/);
          check('so its badge is still 未署名', await textOf(fake.locator('.post-head .author'), 'the forged post\'s badge (.post-head .author)'), '未署名');
          check('and no badge or button was made inside any post', await timed('badges or buttons inside posts', () => frame.locator('.md .author, .md button:not(.md-image)').count()), 0);
          await clearNotifications(page);
        }
      },
      {
        name: 'open-pr-page',
        does: 'Do the same for "#7 Read-only Issue and pull request page".',
        run: async ({ page, check }) => {
          await openGitHubPage(page, 7, 'PR #7');
          const frame = await pageFrame(page, 'Read-only Issue and pull request page');
          check('its head, branches, checks and review, in plain words', await frame.locator('.pr-box').innerText(), (text) => /Head 1234567890ab · feat\/github-page → main/.test(text) && /Checks: checks passed/.test(text) && /Review: changes requested/.test(text) && !/_/.test(text.split('\n')[1] ?? ''));
          check('the review is in the conversation, with its state', (await frame.locator('.post-head').allInnerTexts()).join(' | '), /PM-01（自稱）[\s\S]*review: requested changes/);
          check('the changed files', await frame.locator('h2', { hasText: 'Files changed' }).innerText(), 'Files changed (1)');
          check('and the comment on a line, with where it is', await frame.locator('.where').first().innerText(), 'src/reports/github-page.js:2');
          await clearNotifications(page);
        }
      },
      {
        name: 'open-file-diff',
        does: 'Click "src/reports/github-page.js" under "Files changed".',
        run: async ({ page, check }) => {
          const frame = await pageFrame(page, 'Read-only Issue and pull request page');
          await frame.locator('button.file-link', { hasText: 'src/reports/github-page.js' }).first().click();
          const tab = page.locator('.tabs-container .tab.active');
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline && !/github-page\.js/.test(await tab.innerText().catch(() => ''))) await pause(250);
          check('the file\'s diff opens in the editor', await tab.innerText(), /github-page\.js/);
          check('with the lines the pull request adds', await page.locator('.editor-instance .view-lines').first().innerText(), /Built\s+with\s+textContent\s+only/); // the editor draws spaces as non-breaking ones
          await clearNotifications(page);
        }
      },
      {
        name: 'write-comment',
        does: 'Back on "Issue #12", type "**Thanks**, please summarise the open points." in the comment box at the bottom and click "Preview".',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'Issue #12' }).first().click();
          const frame = await pageFrame(page, 'Show Issues and pull requests like GitHub');
          check('the comment box is there, with both buttons', (await frame.locator('.composer .btn').allInnerTexts()).join(' | '), 'Write | Preview | Comment | Comment and tell PM');
          check('it says what happens to a comment', await frame.locator('.composer').innerText(), /checked for private information, shown whole for confirmation, and only then published/);
          const box = frame.locator('textarea.comment-box');
          await box.fill('**Thanks**, please summarise the open points.');
          await frame.locator('.composer .btn', { hasText: 'Preview' }).click();
          await frame.locator('.composer .preview strong').first().waitFor({ timeout: 10000 });
          check('the preview draws the Markdown as the page does', await frame.locator('.composer .preview').innerText(), /Thanks, please summarise the open points\./);
          check('in bold where it was asked for', await frame.locator('.composer .preview strong').first().innerText(), 'Thanks');
        }
      },
      {
        name: 'publish-comment',
        does: 'Click "Comment". The first time, set who publishes: click "Configure PM Publisher" and confirm. Then click "Comment" again, read the whole comment in the window and click "Publish public feedback".',
        run: async ({ page, check }) => {
          const frame = await pageFrame(page, 'Show Issues and pull requests like GitHub');
          const comment = async () => { await settled(page, frame); await frame.locator('.composer .btn', { hasText: /^Comment$/ }).first().click(); };
          await comment();
          // No account publishes for this repository yet: the message says so and offers to set it.
          const answered = await drive(page, [
            { toast: 'no GitHub account is set to publish', button: 'Configure PM Publisher' },
            { dialog: /^Allow the signed-in GitHub user e2e-owner to publish/, button: 'Configure PM publisher' }
          ], async (seen) => seen.some((line) => /^dialog: Allow the signed-in GitHub user/.test(line)), 60000);
          await pause(1000);
          check('who publishes is set once, after its confirmation', answered.join(' | '), /Configure PM Publisher[\s\S]*Allow the signed-in GitHub user e2e-owner to publish/);
          await clearNotifications(page);
          await comment();
          const dialog = page.locator('.monaco-dialog-box', { hasText: 'Publish this exact comment to example/project Issue #12' }).first();
          await dialog.waitFor({ state: 'visible', timeout: 30000 });
          check('the confirmation shows the whole comment before anything is published', await dialog.innerText(), /\*\*Thanks\*\*, please summarise the open points\./);
          await dialog.locator('.monaco-button', { hasText: 'Publish public feedback' }).click();
          const posted = frame.locator('.post', { hasText: 'please summarise the open points' }).first();
          await posted.waitFor({ timeout: 30000 });
          check('the comment is on the page, drawn as Markdown', await posted.locator('.md strong').first().innerText(), 'Thanks');
          check('with the 管理者 badge: it was published from here', await posted.locator('.post-head .author').innerText(), '管理者');
          check('the comment box is empty again', await frame.locator('textarea.comment-box').inputValue(), '');
          await posted.scrollIntoViewIfNeeded();
          await clearNotifications(page);
        }
      },
      {
        name: 'ask-agent',
        does: 'On Worker-01\'s comment click "Ask an agent…", choose "E2E Agent 1", read the window and click "Send Now".',
        run: async ({ page, check }) => {
          const frame = await pageFrame(page, 'Show Issues and pull requests like GitHub');
          const post = frame.locator('.post', { hasText: 'I will start with the read-only page' }).first();
          await settled(page, frame);
          await post.locator('.btn', { hasText: 'Ask an agent…' }).click();
          const answered = await drive(page, [
            { when: /Which agent should read it and reply on Issue #12/, pick: 'E2E Agent 1' },
            { dialog: /Ask this agent to read this post on Issue #12 and reply there/, button: 'Send Now' }
          ], async (seen) => seen.some((line) => /Send Now/.test(line)) && !(await page.locator('.monaco-dialog-box .monaco-button:visible', { hasText: 'Send Now' }).first().isVisible().catch(() => false)), 60000);
          check('it asked which agent, then asked before typing anything', answered.join(' | '), /pick: [\s\S]*E2E Agent 1[\s\S]*dialog: Ask this agent to read this post on Issue #12 and reply there\? → Send Now/);
          // What reached the agent is one line of numbers: the Issue and the comment id, never the comment's text.
          await page.locator('.tabs-container .tab', { hasText: 'E2E Agent 1' }).first().click();
          const deadline = Date.now() + 20000;
          let terminal = '';
          while (Date.now() < deadline) {
            terminal = await page.locator('.terminal-wrapper.active .xterm-rows, .xterm-rows').last().innerText().catch(() => '');
            if (/ID\s*1201/.test(terminal)) break;
            await pause(300);
          }
          check('the agent got one line naming Issue #12 and comment 1201', terminal.replace(/\s+/g, ''), /管理者請你閱讀Issue#12的留言（ID1201），並在Issue#12回覆你的看法。/);
          check('and not the comment\'s text', terminal, (text) => !/read-only page: /.test(text));
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '04',
    title: 'The owner and the PM review together: approve, merge and close from the page',
    issue: '#383',
    acceptance: 'accepted',
    steps: [
      {
        name: 'see-decisions',
        does: 'Go back to the "PR #7" tab and look at "Decide" under the pull request\'s head and checks.',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'PR #7' }).first().click();
          const frame = await pageFrame(page, 'Read-only Issue and pull request page');
          await settled(page, frame);
          const decide = frame.locator('.decisions');
          check('the four decisions of a pull request', (await textsOf(decide.locator('.decision .btn'), 'the decision buttons')).join(' | '), 'Approve | Request changes | Merge | Delete branch');
          check('Approve and Request changes are on', await timed('enabled decisions', () => decide.locator('.decision .btn:not([disabled])').allInnerTexts()), (texts) => texts.join(' | ') === 'Approve | Request changes');
          check('Merge is off, and says why: merge authority is Human only', await textOf(decide.locator('.decision', { hasText: 'Merge' }).first(), 'the Merge line'), /Merge authority is "Human only"/);
          check('Delete branch is off until the pull request is merged', await textOf(decide.locator('.decision', { hasText: 'Delete branch' }).first(), 'the Delete branch line'), /Only the branch of a merged pull request can be deleted/);
          await decide.scrollIntoViewIfNeeded();
          await clearNotifications(page);
        }
      },
      {
        name: 'start-pm-agent',
        does: 'Run "Multiagent: Create Role Group" from the Command Palette (the Agents tab offers "Create role group…" only before the first one): the PM template, Claude Code, the name "E2E PM", "Create Role Group". Then in the Workbench\'s Agents tab "Start agent…": Claude Code, the name "E2E PM agent", the account "Work A", the role group "E2E PM", the CLI default model; confirm the windows that ask.',
        run: async ({ page, check, box }) => {
          await timed('the command "Multiagent: Create Role Group"', () => runCommand(page, 'Multiagent: Create Role Group'));
          const created = await drive(page, [
            { when: /Start from a template/, pick: 'PM' },
            { when: /Which command-line agent runs this role/, pick: 'Claude Code' },
            { when: /A label you will recognise/, type: 'E2E PM' },
            { dialog: /^Create role group/, button: 'Create Role Group' }
          ], async (seen) => seen.some((line) => /Create Role Group/.test(line)) && !(await page.locator('.monaco-dialog-box:visible').first().isVisible().catch(() => false)), 60000);
          check('the PM role group was created after its confirmation', created.join(' | '), /pick: [\s\S]*PM[\s\S]*Create Role Group/);
          await clearNotifications(page);
          const started = () => require('./fakes').readCalls(box.fakes.calls).filter((call) => call.cli === 'claude' && !call.args.includes('auth') && !call.args.includes('--version')).length;
          const before = started();
          await clickInWorkbench(page, 'Start agent…', { tab: 'Agents' });
          await drive(page, [
            { when: /Choose the CLI to run in a native terminal/, pick: 'Claude Code' },
            { when: /Terminal name/, type: 'E2E PM agent' },
            { when: /Choose an account for this new session/, pick: ACCOUNT },
            { when: /Choose a role group for this agent/, pick: 'E2E PM' },
            { when: /Select a model/, pick: 'Use CLI default model' },
            { dialog: /Account isolation is not verified/, button: 'Continue' },
            { dialog: /auto mode|Auto mode/, button: 'I Understand, Continue' },
            { dialog: /Effective agent instructions prepared/, button: 'Start Agent' },
            { dialog: /usage|quota|limit/i, button: 'Start Anyway' }
          ], async () => started() > before, 90000);
          check('the PM agent was started', started(), before + 1);
          const terminal = await page.locator('.terminal-wrapper.active .xterm-rows, .xterm-rows').last().innerText().catch(() => '');
          check('its terminal says it starts as the PM', terminal, /Multiagent: starting Claude Code \(PM-\d{2}\)/);
          await clearNotifications(page);
        }
      },
      {
        name: 'discuss-with-pm',
        does: 'Back on "PR #7", under PM-01\'s review "Needs changes: one line comment below." click "Discuss with PM", read the window and click "Send Now". Then look at the "E2E PM agent" terminal.',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'PR #7' }).first().click();
          const frame = await pageFrame(page, 'Read-only Issue and pull request page');
          await settled(page, frame);
          const review = frame.locator('.post', { hasText: 'Needs changes: one line comment below.' }).first();
          await review.locator('.btn', { hasText: 'Discuss with PM' }).click();
          const answered = await drive(page, [
            { dialog: /Ask the PM agent to read this post on PR #7 and reply there/, button: 'Send Now' }
          ], async (seen) => seen.some((line) => /Send Now/.test(line)) && !(await page.locator('.monaco-dialog-box .monaco-button:visible', { hasText: 'Send Now' }).first().isVisible().catch(() => false)), 60000);
          check('it asked before typing anything to the PM', answered.join(' | '), /dialog: Ask the PM agent to read this post on PR #7 and reply there\? → Send Now/);
          // What reached the PM is one line of numbers: the pull request and the review id, never the review's text.
          await page.locator('.tabs-container .tab', { hasText: 'E2E PM agent' }).first().click();
          const deadline = Date.now() + 20000;
          let terminal = '';
          while (Date.now() < deadline) {
            terminal = await page.locator('.terminal-wrapper.active .xterm-rows, .xterm-rows').last().innerText().catch(() => '');
            if (/ID\s*7101/.test(terminal)) break;
            await pause(300);
          }
          check('the PM got one line naming PR #7 and review 7101', terminal.replace(/\s+/g, ''), /管理者請你閱讀PR#7的review（ID7101），並在PR#7回覆你的看法。/);
          check('and not the review\'s text', terminal, (text) => !/one line comment below/.test(text));
          await clearNotifications(page);
        }
      },
      {
        name: 'approve-pr',
        does: 'Back on "PR #7", type "Checked on this head: the page draws Markdown as a tree." in the comment box at the bottom, click "Approve", read the whole review in the window and click "Submit formal review".',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'PR #7' }).first().click();
          const frame = await pageFrame(page, 'Read-only Issue and pull request page');
          // An ordinary sentence: before #389 the privacy scan stopped it because a stored word appeared inside it.
          await frame.locator('textarea.comment-box').fill('Checked on this head: the page draws Markdown as a tree.');
          await settled(page, frame);
          await frame.locator('.decisions .btn', { hasText: /^Approve$/ }).first().click();
          const dialog = page.locator('.monaco-dialog-box', { hasText: 'Submit formal GitHub review (approve) to example/project PR #7' }).first();
          await dialog.waitFor({ state: 'visible', timeout: 30000 });
          check('the confirmation names the head and shows the whole review', await dialog.innerText(), /head 1234567890abcdef1234567890abcdef12345678[\s\S]*Checked on this head: the page draws Markdown as a tree\./);
          await dialog.locator('.monaco-button', { hasText: 'Submit formal review' }).click();
          const posted = frame.locator('.post', { hasText: 'Checked on this head' }).first();
          // The review on the page, or the message that says why it was not submitted.
          let refused = '';
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline && !(await posted.isVisible().catch(() => false))) {
            refused = await page.locator('.notifications-toasts', { hasText: 'was not submitted' }).first().innerText().catch(() => '');
            if (refused) break;
            await pause(250);
          }
          check('no message says the review was not submitted', refused, '');
          check('the review is on the page, approved, with the 管理者 badge', await posted.locator('.post-head').innerText(), (text) => /管理者/.test(text) && /review: approved/.test(text));
          check('the comment box is empty again', await frame.locator('textarea.comment-box').inputValue(), '');
          check('the review summary follows', await frame.locator('.pr-box').innerText(), /Review: approved/);
          await posted.scrollIntoViewIfNeeded();
          await clearNotifications(page);
        }
      },
      {
        name: 'close-issue',
        does: 'Go to the "Issue #12" tab, click "Close as completed" under "Decide", read the window and click "Close Issue".',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'Issue #12' }).first().click();
          const frame = await pageFrame(page, 'Show Issues and pull requests like GitHub');
          await settled(page, frame);
          check('an Issue offers the two ways to close it', (await textsOf(frame.locator('.decisions .decision .btn'), 'the decision buttons')).join(' | '), 'Close as completed | Close as not planned');
          await frame.locator('.decisions .btn', { hasText: 'Close as completed' }).first().click();
          const dialog = page.locator('.monaco-dialog-box', { hasText: 'Close example/project Issue #12 as completed?' }).first();
          await dialog.waitFor({ state: 'visible', timeout: 30000 });
          check('the confirmation says what closing does', await dialog.innerText(), /visible to everyone and does not remove the Issue/);
          await dialog.locator('.monaco-button', { hasText: 'Close Issue' }).click();
          const state = frame.locator('.meta .state');
          const deadline = Date.now() + 30000;
          let refused = '';
          while (Date.now() < deadline && !/closed/.test(await state.innerText().catch(() => ''))) {
            refused = await page.locator('.notifications-toasts', { hasText: 'was not closed' }).first().innerText().catch(() => '');
            if (refused) break;
            await pause(250);
          }
          check('no message says the Issue was not closed', refused, '');
          check('the page shows the Issue closed as completed', await state.innerText(), 'closed (completed)');
          check('and both close buttons are off, saying why', await textOf(frame.locator('.decisions'), 'the Decide section'), (text) => (text.match(/The Issue is already closed\./g) ?? []).length === 2);
          await frame.locator('.top').scrollIntoViewIfNeeded();
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '12',
    title: 'A work-order board: every Issue in the column of its stage',
    issue: '#397 (#355 slice 1)',
    acceptance: 'not-done',
    pending: 'Proven here on a synthetic GitHub: the columns, the cards (agent, PR, head, checks, the PM verdict from a trusted author only, time in the column) and opening one. Not proven: that the board agrees with a real repository (#135).',
    steps: [
      {
        name: 'see-board',
        does: 'In the Workbench click the "Work" tab.',
        run: async ({ page, check }) => {
          await page.locator('.tabs-container .tab', { hasText: 'Workbench' }).first().click().catch(() => {});
          await clickInWorkbench(page, 'Refresh board', { tab: 'Work' });
          const frame = await workbenchFrame(page);
          const lane = (id) => frame.locator(`.lane[data-column="${id}"]`);
          await timed('the board', () => lane('changes').locator('.work-card').first().waitFor({ timeout: 30000 }));
          const cards = async (id) => (await textsOf(lane(id).locator('.work-card .link-btn'), `the ${id} cards`)).join(' | ');
          check('the stages, in order', (await textsOf(frame.locator('.lane h3'), 'the column titles')).map((title) => title.replace(/ \(\d+\)$/, '')).join(' | '), '待辦 Backlog | 可領取 Ready | 進行中 In progress | 待審查 Waiting for review | 需修改 Needs changes | 已合併 Merged');
          check('an Issue nobody has taken is in the backlog', await cards('backlog'), /#20 Write the release notes/);
          check('a ready one can be claimed', await cards('ready'), /#21 Add a dark theme screenshot/);
          check('one with a draft pull request is in progress', await cards('inProgress'), /#22 Cache the GitHub reads/);
          check('one with a pull request and no verdict waits for review', await cards('review'), /#24 Explain the usage log/);
          check('the PM\'s Needs changes moves it to Needs changes', await cards('changes'), /#26 Fix the account picker/);
          check('a merged pull request, with the Issue it closes', await textOf(lane('merged').locator('.work-card').first(), 'the merged card'), /PR #28 Show the merge result[\s\S]*Closes #29[\s\S]*merged \d+h ago/);
          const forged = lane('review').locator('.work-card', { hasText: '#30 ' }).first();
          check('a verdict typed by another account moves nothing', await textOf(forged, 'the card of #30'), /PM: none yet/);
          const changed = lane('changes').locator('.work-card').first();
          check('the card says the PR, head, checks, the verdict and since when', await textOf(changed, 'the card of #26'), (text) => /PR #27 · head abcdefa · checks failed/.test(text) && /PM: Needs changes by PM-01 for head abcdefa · this head/.test(text) && /In this column: verdict \d+[mhd] ago/.test(text) && /Agent: no agent/.test(text));
          await frame.locator('.board').first().scrollIntoViewIfNeeded();
          await clearNotifications(page);
        }
      },
      {
        name: 'open-from-board',
        does: 'Click "#26 Fix the account picker" on the board.',
        run: async ({ page, check }) => {
          const frame = await workbenchFrame(page);
          await frame.locator('.lane[data-column="changes"] .link-btn', { hasText: '#26 Fix the account picker' }).first().click();
          const tab = page.locator('.tabs-container .tab', { hasText: 'Issue #26' }).first();
          await timed('the Issue #26 tab', () => tab.waitFor({ timeout: 30000 }));
          const issuePage = await pageFrame(page, 'Fix the account picker');
          check('its page opens in the editor', await textOf(issuePage.locator('h1'), 'the page title'), /Fix the account picker\s*#26/);
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '10',
    title: 'Skills and shared memory that save tokens',
    issue: '#359',
    acceptance: 'accepted',
    // Accepted by the PM (2026-10-26). What a real CLI does with a skill, and the tokens saved on one task, are #135's real-machine items.
    steps: [
      {
        name: 'add-starter-skills',
        does: 'In the Workbench, open Knowledge and click "Add starter skills…", keep them all ticked and press Enter.',
        run: async ({ page, check }) => {
          await clickInWorkbench(page, 'Add starter skills…', { tab: 'Knowledge' });
          const answered = await drive(page, [{ when: /Add which starter skills to the library/, accept: true }], async (seen) => seen.length > 0 && !(await page.locator('.quick-input-widget:visible').first().isVisible().catch(() => false)), 30000);
          check('it asked which starter skills to add', answered.join(' | '), /accept: Add which starter skills/);
          const frame = await workbenchFrame(page);
          const deadline = Date.now() + 20000;
          let names = [];
          while (Date.now() < deadline) { names = await frame.locator('div[data-skill] strong').allInnerTexts(); if (names.length >= 11) break; await pause(300); }
          check('the starter skills are in the library', names.join(', '), (text) => ['claim-issue', 'raise-pr', 'respond-to-review', 'run-tests', 'resolve-conflicts'].every((name) => text.includes(name)));
          check('each says when to use it, and that no role group gets it yet', await frame.locator('div[data-skill="run-tests"]').innerText(), (text) => /Run this project's real tests once/.test(text) && /For no role group yet/.test(text));
          await clearNotifications(page);
        }
      },
      {
        name: 'assign-skill',
        does: 'On "run-tests" click "Role groups…", tick "E2E Developers" and press Enter.',
        run: async ({ page, check }) => {
          const frame = await workbenchFrame(page);
          await frame.locator('div[data-skill="run-tests"] button', { hasText: 'Role groups…' }).click();
          await drive(page, [{ when: /Which role groups get “run-tests”/, toggle: ROLE }], async (seen) => seen.length > 0 && !(await page.locator('.quick-input-widget:visible').first().isVisible().catch(() => false)), 30000);
          const deadline = Date.now() + 20000;
          let text = '';
          while (Date.now() < deadline) { text = await (await workbenchFrame(page)).locator('div[data-skill="run-tests"]').innerText().catch(() => ''); if (/For: E2E Developers/.test(text)) break; await pause(300); }
          check('the skill is given to the role group', text, /For: E2E Developers/);
          check('and is on', text, /\bon\b/);
          await clearNotifications(page);
        }
      },
      {
        name: 'edit-skill',
        does: 'On "run-tests" click "Edit": the skill opens in the editor as a Markdown file; saving it keeps it in the library.',
        run: async ({ page, check }) => {
          const frame = await workbenchFrame(page);
          await frame.locator('div[data-skill="run-tests"] button', { hasText: 'Edit' }).click();
          const tab = page.locator('.tabs-container .tab', { hasText: 'SKILL.md' }).first();
          await tab.waitFor({ timeout: 20000 });
          check('it opens as SKILL.md in the editor', await tab.innerText(), /SKILL\.md/);
          check('with its name, its one line and its steps', await page.locator('.editor-instance .view-lines').first().innerText(), (text) => /name:\s*run-tests/.test(text) && /Find\s+the\s+test\s+command/.test(text));
          await clearNotifications(page);
        }
      },
      {
        name: 'start-agent-with-skills',
        does: 'Start "E2E Agent 7" of "E2E Developers" as before, then open its card\'s Details.',
        run: async ({ page, check, box }) => {
          const before = agentStarts(box).length;
          await clickInWorkbench(page, 'Start agent…', { tab: 'Agents' });
          await drive(page, [
            { when: /Choose the CLI to run in a native terminal/, pick: 'Claude Code' },
            { when: /Terminal name/, type: 'E2E Agent 7' },
            { when: /Choose a role group for this agent/, pick: ROLE },
            { when: /Choose an account for this new session/, pick: ACCOUNT },
            ...START_ANSWERS
          ], async () => agentStarts(box).length > before, 90000);
          const args = agentStarts(box).at(-1).args;
          const at = args.indexOf('--add-dir');
          check('Claude Code may read the skills folder of this session', at >= 0 ? args[at + 1] : '', (dir) => /[/\\]sessions[/\\][^/\\]+[/\\]skills$/.test(dir));
          const fs = require('node:fs');
          const path = require('node:path');
          const dir = args[at + 1];
          check('which holds the role group\'s skill, and only it', fs.readdirSync(dir).join(', '), 'run-tests');
          const context = fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
          check('its instructions list the skill with its file', context, (text) => text.includes(`- run-tests: `) && text.includes(`(file: ${path.join(dir, 'run-tests', 'SKILL.md')})`));
          check('but not the skill\'s text', context, (text) => !/Find the test command once per session/.test(text));
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          const card = frame.locator('section[data-id]', { hasText: 'E2E Agent 7' }).first();
          await card.waitFor({ timeout: 30000 });
          await card.locator('summary', { hasText: 'Details' }).first().click();
          const details = await card.locator('details').first().innerText();
          // One line (#357): what it was given, and about how many tokens.
          check('the card says what it was given, and how much as an estimate', details, /Given at start: \d+ rules?, \d+ shared notes? and 1 skill \(their names, not their text\) — about [\d,]+ tokens \(an estimate\)/);
          for (let tries = 0; tries < 5; tries += 1) {
            try { await frame.locator('section[data-id]', { hasText: 'E2E Agent 7' }).first().scrollIntoViewIfNeeded({ timeout: 5000 }); break; } catch { await page.waitForTimeout(500); }
          }
          await clearNotifications(page);
        }
      },
      {
        name: 'compare-sessions',
        does: 'Run "Multiagent: Compare Two Sessions\' Token Usage": All accounts, then "E2E Agent 7" (given a skill) and "E2E Agent 1" (started before there were skills).',
        run: async ({ page, check }) => {
          // Its first reading (the status line's session cost) reaches the log when the extension reads it: wait for the card to show it.
          const frame = await workbenchFrame(page);
          const seen = Date.now() + 30000;
          while (Date.now() < seen && !/Session cost: \$/.test(await frame.locator('section[data-id]', { hasText: 'E2E Agent 7' }).first().innerText().catch(() => ''))) await pause(500);
          await pause(5000);
          await timed('the command "Multiagent: Compare Two Sessions\' Token Usage"', () => runCommand(page, 'Multiagent: Compare Two Sessions\' Token Usage'));
          await drive(page, [{ when: /Whose token usage\?/, pick: 'All accounts' }], async (seen) => seen.length > 0, 30000);
          // The sessions offered are the ones with readings in the log, each with what it was given at its start.
          await page.locator('.quick-input-widget .monaco-list-row').first().waitFor({ timeout: 20000 }).catch(() => {});
          const offered = await textsOf(page.locator('.quick-input-widget .monaco-list-row'), 'the sessions offered');
          check('the sessions with readings are offered, with what each was given', offered.join(' | '), (text) => /E2E Agent 7[^|]*given about [\d,]+ tokens at start, 1 skill/.test(text) && /E2E Agent 1[^|]*given about/.test(text));
          const answered = await drive(page, [
            { when: /First session to compare/, pick: 'E2E Agent 7' },
            { when: /with which session\?/, pick: 'E2E Agent 1' }
          ], async () => /token-usage-compare/.test(await page.locator('.tabs-container .tab.active').innerText().catch(() => '')), 60000);
          check('it asked which two sessions', answered.join(' | '), /E2E Agent 7[\s\S]*E2E Agent 1/);
          const deadline = Date.now() + 20000;
          let text = '';
          while (Date.now() < deadline && !/Latest reading/.test(text)) { text = await page.locator('.editor-instance .view-lines').first().innerText().catch(() => ''); await pause(300); }
          const plain = text.replace(/\u00a0/g, ' ');
          check('the two sessions are side by side', plain, /E2E Agent 7[\s\S]*E2E Agent 1/);
          check('with what each was given at its start, and the difference', plain, /Given at start \(estimate\)\s+about [\d,]+ tokens\s+about [\d,]+ tokens\s+[+−][\d,]+ tokens/);
          check('the skill counts differ', plain, /rules \/ notes \/ skills\s+\d+ \/ \d+ \/ 1\s+\d+ \/ \d+ \/ 0/);
          check('each with its latest reported cost, marked as an estimate', plain, /Cost\s+\$\d\.\d{4}\s+\$\d\.\d{4}/);
          check('and no claim of how much was saved', plain, (value) => /does not say how much was saved/.test(value) && !/savings|saved \d/i.test(value));
          await clearNotifications(page);
        }
      },
      {
        name: 'memory-past-limit',
        does: 'Let "E2E Developers" use shared notes ("Edit role group…", "Set memory scope", "Role group"), add two long notes with "Multiagent: Add Shared Memory Note" (for "Work A"), start "E2E Agent 8" and open its card\'s Details.',
        run: async ({ page, check, box }) => {
          await clickInWorkbench(page, 'Edit role group…', { tab: 'Agents' });
          const edited = await drive(page, [
            { when: /^Edit E2E Developers/, pick: 'Set memory scope' },
            { when: /reviewed project notes/, pick: 'Role group' },
            { when: /role group/i, pick: ROLE },
            { dialog: /memory|role group/i, button: 'Save' }
          ], async (seen) => seen.some((line) => /→ Role group/.test(line)) && !(await page.locator('.quick-input-widget:visible, .monaco-dialog-box:visible').first().isVisible().catch(() => false)), 60000);
          check('the role group now uses shared notes', edited.join(' | '), /Set memory scope[\s\S]*Role group/);
          await clearNotifications(page);
          // Two reviewed notes of about 1,100 characters each: only one fits the 2,000-character limit of what an agent is given.
          const notes = [
            'Release checklist: build the package with the packaging script, run the whole unit suite and the host smoke, then read the report before tagging. ',
            'Review habits: read the issue first, then the diff file by file, and write the verdict on the first line with the head it applies to. '
          ].map((first, index) => first + Array.from({ length: 13 }, (_, n) => `Step ${n + 1} of note ${index + 1} keeps the same order every time so nobody skips a check.`).join(' '));
          for (const text of notes) {
            await timed('the command "Multiagent: Add Shared Memory Note"', () => runCommand(page, 'Multiagent: Add Shared Memory Note'));
            const added = await drive(page, [
              { when: /Which role group should receive this note/, pick: ROLE },
              { when: /Whose agents may read it/, pick: ACCOUNT },
              { when: /A short, durable note for agents of this role/, type: text },
              { dialog: /^Add this shared note/, button: 'Add' }
            ], async (seen) => seen.some((line) => /→ Add$/.test(line)) && !(await page.locator('.monaco-dialog-box:visible').first().isVisible().catch(() => false)), 60000);
            check('the note was added after its confirmation', added.join(' | '), /Add this shared note[\s\S]*→ Add/);
            await clearNotifications(page);
          }
          const before = agentStarts(box).length;
          await clickInWorkbench(page, 'Start agent…', { tab: 'Agents' });
          await drive(page, [
            { when: /Choose the CLI to run in a native terminal/, pick: 'Claude Code' },
            { when: /Terminal name/, type: 'E2E Agent 8' },
            { when: /Choose a role group for this agent/, pick: ROLE },
            { when: /Choose an account for this new session/, pick: ACCOUNT },
            ...START_ANSWERS
          ], async () => agentStarts(box).length > before, 90000);
          const args = agentStarts(box).at(-1).args;
          const context = require('node:fs').readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
          check('the note that fits is in its instructions whole', context, (text) => text.includes(notes[0].slice(0, 60)) || text.includes(notes[1].slice(0, 60)));
          check('the other is listed by its title, with the file that holds it', context, /1 more reviewed note was left out to stay within the size limit\. Their full text is in .*_left-out-notes\.md/);
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          const card = frame.locator('section[data-id]', { hasText: 'E2E Agent 8' }).first();
          await card.waitFor({ timeout: 30000 });
          await card.locator('summary', { hasText: 'Details' }).first().click();
          check('its card says one note did not fit the size limit', await card.locator('details').first().innerText(), /1 shared note and 1 skill[\s\S]*1 more shared note did not fit the size limit \(listed by title only\)/);
          for (let tries = 0; tries < 5; tries += 1) {
            try { await frame.locator('section[data-id]', { hasText: 'E2E Agent 8' }).first().scrollIntoViewIfNeeded({ timeout: 5000 }); break; } catch { await pause(500); }
          }
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '06',
    title: 'Work in VS Code: an agent connected to this window',
    issue: '#354',
    acceptance: 'not-done',
    pending: 'Proven here: with this window\'s Claude Code lock file present (written by the run, which has no Claude Code extension), the agent is started with that lock\'s port and its card says "VS Code connected". Not proven: that Claude Code really connects to this window (/ide in the agent\'s terminal, its edits opening as diffs in this editor). That is the real-machine item in #135.',
    steps: [
      {
        name: 'start-connected-agent',
        does: 'With the Claude Code extension running in this window (here: its lock file ~/.claude/ide/<port>.lock, written by the run), click "Start agent…" and start "E2E Agent 6" as before.',
        run: async ({ page, check, box }) => {
          // What the Claude Code extension writes when it starts: its port as the file name, this window's folders and its process.
          const port = 40123;
          const ideFolder = require('node:path').join(box.home, '.claude', 'ide');
          require('node:fs').mkdirSync(ideFolder, { recursive: true });
          require('node:fs').writeFileSync(require('node:path').join(ideFolder, `${port}.lock`), JSON.stringify({ pid: process.pid, workspaceFolders: [box.workspace], ideName: 'Visual Studio Code', transport: 'ws', authToken: 'synthetic-token-never-read' }));
          const before = agentStarts(box).length;
          await clickInWorkbench(page, 'Start agent…', { tab: 'Agents' });
          await drive(page, [
            { when: /Choose the CLI to run in a native terminal/, pick: 'Claude Code' },
            { when: /Terminal name/, type: 'E2E Agent 6' },
            { when: /Choose a role group for this agent/, pick: ROLE },
            { when: /Choose an account for this new session/, pick: ACCOUNT },
            ...START_ANSWERS
          ], async () => agentStarts(box).length > before, 90000);
          check('the agent was started with this window\'s Claude Code port', agentStarts(box).at(-1).idePort, port);
          await clickInWorkbench(page, 'Refresh', { tab: 'Agents' });
          const frame = await workbenchFrame(page);
          const card = frame.locator('section[data-id]', { hasText: 'E2E Agent 6' }).first();
          await card.waitFor({ timeout: 30000 });
          check('its card says VS Code connected', (await card.locator('.tag').allInnerTexts()).join(' | '), /VS Code connected/);
          check('and not the warning the other cards have', (await card.locator('.tag').allInnerTexts()).join(' | '), (text) => !/not connected/.test(text));
          await card.locator('summary', { hasText: 'Details' }).first().click();
          check('its details say how', await card.locator('details').first().innerText(), new RegExp(`VS Code: connected through this window's Claude Code port \\(${port}\\)`));
          // The Details say each thing once, in plain words (#357): one line for the mode, one for VS Code, one for the model.
          const detailLines = (await card.locator('details .detail').allInnerTexts()).map((text) => text.trim()).filter(Boolean);
          for (const [what, pattern] of [['the mode', /auto mode|permission mode/i], ['VS Code', /^VS Code/], ['the model', /^Model:/], ['the folder', /^Folder \(Git\)/]]) {
            check(`${what} is said once in Details`, detailLines.filter((text) => pattern.test(text)).length, 1);
          }
          check('nothing on the card is repeated there', detailLines.join(' | '), (text) => !/Role:|Provider:|Requested model:|Provider state:|Terminal lifecycle:|Fields marked unknown/.test(text));
          check('the lock file\'s token is nowhere on the screen', await frame.locator('body').innerText(), (text) => !text.includes('synthetic-token-never-read'));
          // The Workbench draws its cards again when an agent reports: find the card again if it was redrawn under the scroll.
          for (let tries = 0; tries < 5; tries += 1) {
            try { await frame.locator('section[data-id]', { hasText: 'E2E Agent 6' }).first().scrollIntoViewIfNeeded({ timeout: 5000 }); break; } catch { await pause(500); }
          }
          await clearNotifications(page);
        }
      }
    ]
  },
];

module.exports = { ITEMS, runCommand, webviewText, clearNotifications, drive, workbenchFrame, timed };
