#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Claude Code statusLine bridge script.
 * Claude Code passes session state JSON via stdin to the command configured in `statusLine`.
 *
 * This script extracts `rate_limits` (available on claude.ai Pro/Max subscription accounts)
 * and writes them to a local JSON file for the Multiagent extension to observe.
 *
 * It is designed to never fail or block Claude Code:
 * - Empty, invalid, or timed-out stdin exits cleanly with code 0.
 * - File write errors are caught and ignored (fail closed).
 * - Clean status line text is written to stdout for terminal footer display.
 */
function runBridge(args = process.argv.slice(2), stdinStream = process.stdin, stdoutStream = process.stdout, now = new Date()) {
  const targetPath = args[0] || (
    process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-quota.json')
      : null
  );

  let buffer = '';
  let finished = false;

  const MAX_BUFFER = 64 * 1024;
  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      process.exitCode = 0;
      if (typeof stdinStream.destroy === 'function') stdinStream.destroy();
      else if (typeof stdinStream.pause === 'function') stdinStream.pause();
    }
  }, 3000);
  if (timer.unref) timer.unref();

  stdinStream.setEncoding('utf8');
  stdinStream.on('data', (chunk) => {
    if (buffer.length < MAX_BUFFER) {
      buffer += chunk;
    }
  });

  const onEnd = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);

    try {
      const trimmed = buffer.trim();
      if (!trimmed) {
        process.exitCode = 0;
        return;
      }

      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        process.exitCode = 0;
        return;
      }

      if (!payload || typeof payload !== 'object') {
        process.exitCode = 0;
        return;
      }

      // If target path is provided, persist sanitized quota observation
      if (targetPath) {
        let sanitizedRateLimits = null;
        if (payload.rate_limits && typeof payload.rate_limits === 'object') {
          sanitizedRateLimits = {};
          for (const windowKey of ['five_hour', 'seven_day']) {
            const entry = payload.rate_limits[windowKey];
            if (entry && typeof entry === 'object') {
              sanitizedRateLimits[windowKey] = {
                used_percentage: typeof entry.used_percentage === 'number' ? entry.used_percentage : null,
                resets_at: typeof entry.resets_at === 'number' ? entry.resets_at : null
              };
            }
          }
        }

        const record = {
          observedAt: now.toISOString(),
          rate_limits: sanitizedRateLimits,
          model: (payload.model && typeof payload.model.display_name === 'string')
            ? payload.model.display_name
            : null
        };

        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const tempFile = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tempFile, JSON.stringify(record, null, 2), { mode: 0o600 });
        fs.renameSync(tempFile, targetPath);
      }

      // Format clean status line for Claude Code terminal output
      const parts = [];
      if (payload.model && typeof payload.model.display_name === 'string') {
        parts.push(payload.model.display_name);
      }
      if (payload.rate_limits && typeof payload.rate_limits === 'object') {
        const fiveHour = payload.rate_limits.five_hour;
        if (fiveHour && typeof fiveHour.used_percentage === 'number') {
          parts.push(`5h: ${fiveHour.used_percentage}%`);
        }
        const sevenDay = payload.rate_limits.seven_day;
        if (sevenDay && typeof sevenDay.used_percentage === 'number') {
          parts.push(`7d: ${sevenDay.used_percentage}%`);
        }
      }

      if (parts.length > 0 && stdoutStream && typeof stdoutStream.write === 'function') {
        stdoutStream.write(parts.join(' | ') + '\n');
      }
    } catch {
      // Fail closed, never fail or exit non-zero
    }
    process.exitCode = 0;
  };

  stdinStream.on('end', onEnd);
  stdinStream.on('error', () => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      process.exitCode = 0;
    }
  });
}

if (require.main === module) {
  runBridge();
}

module.exports = { runBridge };
