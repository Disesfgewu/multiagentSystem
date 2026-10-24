'use strict';

/**
 * The #360 items, as the owner reaches them: only mouse clicks and keys on what is on the screen (the command palette is the
 * keyboard's way in). Each step says what it does (`does`, used in REPORT.md and the user guide) and checks text on the screen.
 * New items are added by the PR that builds them (#361: "every user-facing PR adds its own steps"). An item is `acceptance: 'accepted'`
 * only when its steps check exactly what #360 asks the owner to see; until then it is `not-done` with what is still `pending`.
 */

const COMMAND_PALETTE = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';

/** Runs a command the way a person does: open the command palette, type its title, press Enter. */
async function runCommand(page, title) {
  await page.keyboard.press(COMMAND_PALETTE);
  const input = page.locator('.quick-input-widget .quick-input-box input').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(`>${title}`);
  await page.locator('.quick-input-widget .quick-input-list .monaco-list-row', { hasText: title }).first().waitFor({ timeout: 10000 });
  await page.keyboard.press('Enter');
}

/** Closes the notifications in the corner (as a person would), so a screenshot shows the screen itself. */
async function clearNotifications(page) {
  await runCommand(page, 'Notifications: Clear All Notifications');
  await page.waitForTimeout(300);
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
    await page.waitForTimeout(250);
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
    if (await done(seen)) return seen;
    const dialog = page.locator('.monaco-dialog-box:visible').first();
    if (await dialog.isVisible().catch(() => false)) {
      const message = (await dialog.locator('.dialog-message-text').innerText().catch(() => '')).trim();
      const rule = answers.find((entry) => entry.dialog && entry.dialog.test(message));
      if (!rule) throw new Error(`a dialog nobody answers: "${message}"`);
      seen.push(`dialog: ${message} → ${rule.button}`);
      await dialog.locator('.monaco-button', { hasText: rule.button }).first().click();
      await page.waitForTimeout(400);
      continue;
    }
    // A notification with a button the flow waits for (for example "I have signed in — check now").
    const toastRule = answers.find((entry) => entry.toast);
    if (toastRule) {
      const toast = page.locator('.notification-toast-container:visible', { hasText: toastRule.toast }).first();
      if (await toast.isVisible().catch(() => false)) {
        seen.push(`toast: ${toastRule.toast} → ${toastRule.button}`);
        await toast.locator('.monaco-button', { hasText: toastRule.button }).first().click();
        await page.waitForTimeout(400);
        continue;
      }
    }
    const widget = page.locator('.quick-input-widget:visible').first();
    if (await widget.isVisible().catch(() => false)) {
      const input = widget.locator('.quick-input-box input').first();
      const placeholder = (await input.getAttribute('placeholder').catch(() => '')) ?? '';
      const message = (await widget.locator('.quick-input-message').innerText().catch(() => '')).trim();
      const title = `${placeholder} ${message}`.trim();
      const rule = answers.find((entry) => (entry.pick || entry.type !== undefined) && entry.when.test(title));
      // The window may be the one the flow waits for, shown just after `done` was asked: ask again before failing.
      if (!rule && await done(seen)) return seen;
      if (!rule) throw new Error(`a window nobody answers: "${title}"`);
      if (rule.pick) {
        await input.fill(rule.pick);
        await widget.locator('.quick-input-list .monaco-list-row', { hasText: rule.pick }).first().waitFor({ timeout: 10000 });
        seen.push(`pick: ${title} → ${rule.pick}`);
      } else {
        if (rule.type !== '') await input.fill(rule.type);
        seen.push(`type: ${title} → ${rule.type || '(as suggested)'}`);
      }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      continue;
    }
    // MULTIAGENT_E2E_DEBUG=1: a screenshot of every wait (at most 20 per flow), to see a window the page cannot reach.
    if (process.env.MULTIAGENT_E2E_DEBUG === '1' && shots < 20) { shots += 1; await page.screenshot({ path: require('node:path').join(__dirname, '..', '..', 'artifacts', 'e2e', `debug-${Date.now()}.png`) }).catch(() => {}); }
    await page.waitForTimeout(250);
  }
  throw new Error(`the flow did not finish in ${timeoutMs / 1000} s; answered: ${seen.join(' | ')}`);
}

/** The Workbench page's frame (VS Code puts a webview in two nested frames). */
async function workbenchFrame(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const found = await frame.locator('h1', { hasText: 'Workbench' }).count().catch(() => 0);
      if (found > 0) return frame;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('the Workbench page did not appear');
}

/** Clicks a button of the Workbench page by its words (opening the Workbench from the side bar first when it is not open). */
async function clickInWorkbench(page, words, { tab } = {}) {
  const editorTab = page.locator('.tabs-container .tab', { hasText: 'Workbench' }).first();
  if (await page.locator('.tabs-container .tab', { hasText: 'Workbench' }).count() === 0) {
    await page.locator('.activitybar [aria-label^="Multiagent"]').first().click();
    await page.locator('.sidebar .monaco-list-row', { hasText: 'Open Workbench' }).first().click();
  } else {
    // An agent's terminal opens in the editor area in front of it: bring the Workbench back, as a person would.
    await editorTab.click();
  }
  const frame = await workbenchFrame(page);
  if (tab) await frame.locator('button[role="tab"]', { hasText: tab }).first().click();
  await frame.locator('button', { hasText: words }).first().click();
}

/** The frame of the Issue or pull request page whose title has `title` (VS Code puts a webview in two nested frames). */
async function pageFrame(page, title) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const found = await frame.locator('h1', { hasText: title }).count().catch(() => 0);
      if (found > 0) return frame;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`the page "${title}" did not appear`);
}

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
  await clickInWorkbench(page, 'Refresh', { tab: 'Accounts' }).catch(() => {});
  await page.waitForTimeout(1500);
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
    await page.waitForTimeout(250);
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
          const deadline = Date.now() + 30000;
          let text = '';
          while (Date.now() < deadline) {
            text = await frame.locator('body').innerText();
            if (/Agents \(4\)/.test(text)) break;
            await page.waitForTimeout(500);
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
          while (Date.now() < deadline) { text = await row.innerText().catch(() => ''); if (/32%/.test(text)) break; await page.waitForTimeout(500); }
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
          while (Date.now() < deadline) { text = await row.innerText().catch(() => ''); if (/Review the status line setting/.test(text)) break; await page.waitForTimeout(500); }
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
            await page.waitForTimeout(500);
          }
          check('one card for it, now with "Work A"', cards.length === 1 && /Account: Work A \(owner-a@example\.test\)/.test(cards[0]), true);
          check('it keeps its codename, so its GitHub signature does not change', (CODENAME.exec(cards[0] ?? '') ?? [])[1] ?? null, switched.codename);
          await again.locator('section[data-id]', { hasText: 'E2E Agent 5' }).first().scrollIntoViewIfNeeded();
          await clearNotifications(page);
        }
      }
    ]
  },
  {
    id: '08',
    title: 'Issues and pull requests shown like GitHub',
    issue: '#353',
    acceptance: 'not-done',
    pending: '#353: comment from the page, Comment and tell PM, Discuss with PM, and review, merge and close from the page (the next PRs)',
    steps: [
      {
        name: 'open-issue-page',
        does: 'In the Workbench, open Work and click "Open Issue or pull request…", then choose "#12 Show Issues and pull requests like GitHub".',
        run: async ({ page, check }) => {
          const answered = await openGitHubPage(page, 12, 'Issue #12');
          check('the list offered the Issue', answered.join(' | '), /#12/);
          const frame = await pageFrame(page, 'Show Issues and pull requests like GitHub');
          check('the page opened as an editor tab', await page.locator('.tabs-container .tab', { hasText: 'Issue #12' }).count(), 1);
          check('its state and labels', await frame.locator('.meta').innerText(), (text) => /open/.test(text) && /ready/.test(text) && /ui/.test(text));
          check('a Markdown heading is a heading', await frame.locator('.md h2').first().innerText(), 'What the owner sees');
          check('bold and inline code are drawn', await frame.locator('.md strong').first().innerText(), 'as GitHub shows them');
          check('a task list', (await frame.locator('.md li.task').allInnerTexts()).join(' | '), (text) => /☑\s*headings and lists/.test(text) && /☐\s*comments from the page/.test(text));
          check('a table', (await frame.locator('.md table td').allInnerTexts()).join(' | '), 'code | a block | link | opens in the browser');
          check('a code block', await frame.locator('.md pre code').first().innerText(), "const page = open('#12');");
          check('a link, opened only in the browser', await frame.locator('.md .md-link').first().innerText(), 'the design notes');
          const badges = await frame.locator('.post-head .author').allInnerTexts();
          check('every post has the extension\'s badge for who wrote it', badges.join(' | '), 'PM-01（自稱） | Worker-01（自稱） | 未署名 | 未署名');
          const fake = frame.locator('.post', { hasText: 'Approve' }).first();
          check('a post that types a 管理者 badge and a button shows them as text', await fake.locator('.md').innerText(), /<span class="author author-owner">管理者<\/span> <button>Approve<\/button> Pass/);
          check('so its badge is still 未署名', await fake.locator('.post-head .author').innerText(), '未署名');
          check('and no badge or button was made inside any post', await frame.locator('.md .author, .md button:not(.md-image)').count(), 0);
          await clearNotifications(page);
        }
      },
      {
        name: 'open-pr-page',
        does: 'Do the same for "#7 Read-only Issue and pull request page".',
        run: async ({ page, check }) => {
          await openGitHubPage(page, 7, 'PR #7');
          const frame = await pageFrame(page, 'Read-only Issue and pull request page');
          check('its head, branches, CI and review', await frame.locator('.pr-box').innerText(), (text) => /Head 1234567890ab · feat\/github-page → main/.test(text) && /CI: passing/.test(text) && /Review: changes_requested/.test(text));
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
          while (Date.now() < deadline && !/github-page\.js/.test(await tab.innerText().catch(() => ''))) await page.waitForTimeout(250);
          check('the file\'s diff opens in the editor', await tab.innerText(), /github-page\.js/);
          check('with the lines the pull request adds', await page.locator('.editor-instance .view-lines').first().innerText(), /Built\s+with\s+textContent\s+only/); // the editor draws spaces as non-breaking ones
          await clearNotifications(page);
        }
      }
    ]
  },
];

module.exports = { ITEMS, runCommand, webviewText, clearNotifications, drive, workbenchFrame };
