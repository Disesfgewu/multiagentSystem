'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Runs the steps of each #360 item and keeps what happened: every step's screenshot, every check with what was expected and what
 * was on the screen, and the first failure. `write` turns it into `REPORT.md`. A step that throws stops its item (the later steps
 * of that item depend on it) but not the other items.
 */
class Recorder {
  constructor(out) {
    this.out = out;
    this.items = [];
    this.fatalError = null;
  }

  /** @returns {Promise<boolean>} whether every step of the item passed */
  async item(item, page, box) {
    const record = { id: item.id, title: item.title, issue: item.issue, steps: [], ok: true };
    this.items.push(record);
    for (const step of item.steps) {
      const entry = { name: step.name, does: step.does, checks: [], screenshot: null, error: null };
      record.steps.push(entry);
      const file = `${item.id}-${step.name}.png`;
      const ctx = {
        page,
        box,
        // A check is recorded whether it holds or not; one that does not hold fails the step.
        check: (label, actual, expected) => {
          const ok = typeof expected === 'function' ? Boolean(expected(actual)) : expected instanceof RegExp ? expected.test(String(actual)) : actual === expected;
          entry.checks.push({ label, ok, actual: shorten(actual) });
          if (!ok) throw new Error(`check failed: ${label} (saw: ${shorten(actual)})`);
        }
      };
      try {
        await step.run(ctx);
        await page.screenshot({ path: path.join(this.out, file) });
        entry.screenshot = file;
      } catch (error) {
        entry.error = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 400);
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
    return `${passed} of ${this.items.length} items passed${this.fatalError ? ' (the run stopped early)' : ''}`;
  }

  write(meta) {
    const lines = ['# End-to-end report (#361)', '', `VS Code ${meta.vscode}, ${new Date().toISOString()}. Synthetic CLIs and data only; the extension's first-use download is switched off and VS Code's own requests go to a closed local proxy (the network is not blocked by the operating system). What this proves is the screen and the flow, not a real account or CLI (#135).`, '', `**${this.summary()}**`, ''];
    if (this.fatalError) lines.push('## The run stopped', '', '```', this.fatalError, '```', '');
    lines.push('| # | Item | Result |', '|---|---|---|');
    for (const item of this.items) lines.push(`| ${item.id} | ${item.title} | ${item.ok ? 'pass' : 'FAIL'} |`);
    for (const item of this.items) {
      lines.push('', `## ${item.id}. ${item.title} — ${item.ok ? 'pass' : 'FAIL'}`, '', `Issue: ${item.issue}`);
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

module.exports = { Recorder };
