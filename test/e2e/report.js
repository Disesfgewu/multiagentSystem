'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Whether an item meets #360's acceptance, which is not the same as its checks passing (#371): `accepted` only when the steps check
 * exactly what #360 asks the owner to see; `framework` when they only show the screen can be reached; `not-done` when the feature is
 * not built yet (with the issue that builds it). The report never calls an item accepted unless it says so here and every check held.
 */
const ACCEPTANCE = Object.freeze({ accepted: 'accepted', framework: 'framework check', 'not-done': 'not done' });

/**
 * Runs the steps of each #360 item and keeps what happened: every step's screenshot, every check with what was expected and what
 * was on the screen, and the first failure. `write` turns it into `REPORT.md`. A step that throws stops its item (the later steps
 * of that item depend on it) but not the other items.
 */
class Recorder {
  constructor(out, { stepLimitMs = 120000 } = {}) {
    this.out = out;
    this.stepLimitMs = stepLimitMs;
    this.items = [];
    this.fatalError = null;
  }

  /** @returns {Promise<boolean>} whether every step of the item passed */
  async item(item, page, box) {
    const acceptance = Object.hasOwn(ACCEPTANCE, item.acceptance) ? item.acceptance : 'not-done';
    const record = { id: item.id, title: item.title, issue: item.issue, acceptance, pending: typeof item.pending === 'string' ? item.pending : null, steps: [], ok: true };
    this.items.push(record);
    for (const step of item.steps) {
      const entry = { name: step.name, does: step.does, checks: [], screenshot: null, error: null };
      record.steps.push(entry);
      const file = `${item.id}-${step.name}.png`;
      const started = Date.now();
      const ctx = {
        page,
        box,
        // A check is recorded whether it holds or not; one that does not hold fails the step.
        check: (label, actual, expected) => {
          const ok = typeof expected === 'function' ? Boolean(expected(actual)) : expected instanceof RegExp ? expected.test(String(actual)) : actual === expected;
          entry.checks.push({ label, ok, actual: shorten(actual) });
          console.log(`e2e:   ${((Date.now() - started) / 1000).toFixed(1)} s ${ok ? 'ok' : 'FAILED'}: ${label}`);
          if (!ok) throw new Error(`check failed: ${label} (saw: ${shorten(actual)})`);
        }
      };
      // Printed as it happens, so a run that is stopped from outside still says which step it was in.
      console.log(`e2e: ${item.id} ${step.name} …`);
      let timer;
      globalThis.e2eLastAction = 'none yet';
      // A heartbeat while the step runs: how long it has run and the last action it started or finished (#385).
      const heartbeat = setInterval(() => console.log(`e2e:   … ${item.id} ${step.name} running for ${Math.round((Date.now() - started) / 1000)} s; last: ${globalThis.e2eLastAction}`), 15000);
      try {
        // A step that does not finish in time fails, with a screenshot, instead of holding the whole run (#353, PR #380 review).
        await Promise.race([
          step.run(ctx),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`the step did not finish in ${this.stepLimitMs / 1000} s`)), this.stepLimitMs); })
        ]);
        clearTimeout(timer);
        clearInterval(heartbeat);
        await page.screenshot({ path: path.join(this.out, file) });
        entry.screenshot = file;
      } catch (error) {
        clearTimeout(timer);
        clearInterval(heartbeat);
        entry.error = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 400);
        console.log(`e2e: ${item.id} ${step.name} failed after ${Math.round((Date.now() - started) / 1000)} s: ${entry.error}`);
        const failed = `${item.id}-${step.name}-failed.png`;
        try { await page.screenshot({ path: path.join(this.out, failed) }); entry.screenshot = failed; } catch { /* the window may be gone */ }
        record.ok = false;
        break;
      }
    }
    return record.ok;
  }

  fatal(error) {
    this.fatalError = String(error && error.stack ? error.stack : error).slice(0, 2000);
  }

  /** The screenshots of the steps that passed, in order. */
  screenshots() {
    return this.items.flatMap((item) => item.steps.filter((step) => !step.error && step.screenshot).map((step) => step.screenshot));
  }

  summary() {
    const passed = this.items.filter((item) => item.ok).length;
    const accepted = this.items.filter((item) => item.ok && item.acceptance === 'accepted').length;
    return `checks: ${passed} of ${this.items.length} items passed; accepted (#360): ${accepted} of ${this.items.length}${this.fatalError ? ' (the run stopped early)' : ''}`;
  }

  /** What the report says of one item: whether its checks held, and whether it meets #360's acceptance. */
  static verdict(item) {
    if (!item.ok) return 'FAIL';
    if (item.acceptance === 'accepted') return 'accepted';
    return item.acceptance === 'framework' ? 'checks pass — framework check only, not accepted' : `checks pass — NOT DONE${item.pending ? ` (${item.pending})` : ''}`;
  }

  write(meta) {
    const lines = ['# End-to-end report (#361)', '', `VS Code ${meta.vscode}, ${new Date().toISOString()}. Synthetic CLIs and data only; the extension's first-use download is switched off and VS Code's own requests go to a closed local proxy (the network is not blocked by the operating system). What this proves is the screen and the flow, not a real account or CLI (#135).`, '', `**${this.summary()}**`, ''];
    if (this.fatalError) lines.push('## The run stopped', '', '```', this.fatalError, '```', '');
    lines.push('Only an item marked **accepted** meets #360. "Checks pass" means the screen can be reached and shows what is checked below; it is not the acceptance.', '', '| # | Item | Result |', '|---|---|---|');
    for (const item of this.items) lines.push(`| ${item.id} | ${item.title} | ${Recorder.verdict(item)} |`);
    for (const item of this.items) {
      lines.push('', `## ${item.id}. ${item.title} — ${Recorder.verdict(item)}`, '', `Issue: ${item.issue}`);
      if (item.pending) lines.push('', `Still to do for the acceptance: ${item.pending}`);
      for (const step of item.steps) {
        lines.push('', `### ${step.name}: ${step.does}`, '');
        for (const check of step.checks) lines.push(`- ${check.ok ? '✔' : '✘'} ${check.label} — saw: \`${check.actual.replace(/`/g, "'")}\``);
        if (step.error) lines.push(`- ✘ ${step.error}`);
        if (step.screenshot) lines.push('', `![${item.id} ${step.name}](${step.screenshot})`);
      }
    }
    fs.writeFileSync(path.join(this.out, 'REPORT.md'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(this.out, 'report.json'), JSON.stringify({ meta, items: this.items, fatal: this.fatalError }, null, 2));
  }
}

function shorten(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

module.exports = { Recorder, ACCEPTANCE };
