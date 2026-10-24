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
          await clearNotifications(page);
        }
      }
    ]
  },
];

module.exports = { ITEMS, runCommand, webviewText, clearNotifications, drive, workbenchFrame };
