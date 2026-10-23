'use strict';

/**
 * The #360 items, as the owner reaches them: only mouse clicks and keys on what is on the screen (the command palette is the
 * keyboard's way in). Each step says what it does (`does`, used in REPORT.md and the user guide) and checks text on the screen.
 * New items are added by the PR that builds them (#361: "every user-facing PR adds its own steps").
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

const ITEMS = [
  {
    id: '00',
    title: 'The Multiagent side bar',
    issue: '#357 (the side bar is to keep one entry; this records how it looks today)',
    steps: [
      {
        name: 'open-side-bar',
        does: 'Click the Multiagent icon in the activity bar.',
        run: async ({ page, check }) => {
          await page.locator('.activitybar [aria-label^="Multiagent"]').first().click();
          const header = page.locator('.sidebar .composite.title');
          await header.waitFor({ timeout: 10000 });
          check('the side bar shows Multiagent', await header.innerText(), /MULTIAGENT/i);
          const views = await page.locator('.sidebar .pane-header').allInnerTexts();
          check('its views are listed', views.join(' | '), (text) => /Overview/i.test(text));
        }
      }
    ]
  },
  {
    id: '11',
    title: 'One screen with every agent working on this project',
    issue: '#357 (Agents tab), #368',
    steps: [
      {
        name: 'open-command-center',
        does: 'Open the command palette, type "Multiagent: Open Command Center" and press Enter.',
        run: async ({ page, check }) => {
          await runCommand(page, 'Multiagent: Open Command Center');
          const tab = page.locator('.tabs-container .tab', { hasText: 'Command Center' });
          await tab.first().waitFor({ timeout: 20000 });
          check('a Command Center tab opens in the editor area', await tab.first().innerText(), /Command Center/);
          const text = await webviewText(page, 'Command Center', (body) => /Agents \(\d+\)/.test(body));
          check('the page shows the agents section with a count', text, /Agents \(\d+\)/);
          check('and the accounts section', text, /Accounts \(\d+\)/);
          await clearNotifications(page);
        }
      }
    ]
  }
];

module.exports = { ITEMS, runCommand, webviewText, clearNotifications };
