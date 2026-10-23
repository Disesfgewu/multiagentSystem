#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SESSION_ID_ENV = 'MULTIAGENT_CLAUDE_SESSION_ID';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
// Claude Code's own session id, as documented for the status line input: an opaque, short token.
const PROVIDER_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
// A per-model weekly window of `rate_limits` (for example `seven_day_opus`), and how many windows are kept at most.
const SEVEN_DAY_MODEL = /^seven_day_[a-z][a-z0-9_]{0,39}$/;
const MAX_WINDOWS = 8;

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
    if (finished) return;
    if (Buffer.byteLength(buffer, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_BUFFER) {
      finished = true;
      clearTimeout(timer);
      process.exitCode = 0;
      if (typeof stdinStream.destroy === 'function') stdinStream.destroy();
      else if (typeof stdinStream.pause === 'function') stdinStream.pause();
      return;
    }
    buffer += chunk;
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
          // The 5-hour and weekly windows, and the per-model weekly ones (`seven_day_opus`, `seven_day_sonnet`, ...): only the
          // percent and the reset time of each are kept.
          const windowKeys = Object.keys(payload.rate_limits).filter((key) => key === 'five_hour' || key === 'seven_day' || SEVEN_DAY_MODEL.test(key)).slice(0, MAX_WINDOWS);
          for (const windowKey of windowKeys) {
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

        const tempFile = `${targetPath}.tmp.${randomUUID()}`;
        // 'wx': never write through a link or over a file someone else put at that name.
        fs.writeFileSync(tempFile, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tempFile, targetPath);
      }

      // A managed terminal receives only an opaque, validated local session id. Keeping the
      // destination below CLAUDE_CONFIG_DIR prevents inherited environment values from selecting
      // an arbitrary write location. The record contains only documented status-line fields.
      const managedSessionId = process.env[SESSION_ID_ENV];
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      if (configDir && SESSION_ID.test(managedSessionId || '')) {
        const observationPath = path.join(configDir, 'session-observations', `${managedSessionId}.json`);
        const statusLine = {};
        if (payload.model && typeof payload.model.id === 'string') {
          statusLine.model = { id: payload.model.id };
        }
        if (payload.cost && typeof payload.cost.total_cost_usd === 'number') {
          statusLine.cost = { total_cost_usd: payload.cost.total_cost_usd };
        }
        if (Object.keys(statusLine).length > 0) {
          const observedAt = now.toISOString();
          const record = {
            schemaVersion: 1,
            eventId: randomUUID(),
            observedAt,
            sequence: Date.parse(observedAt),
            statusLine
          };
          // Only the id itself, and only when it has the documented shape; never the transcript path.
          if (typeof payload.session_id === 'string' && PROVIDER_SESSION_ID.test(payload.session_id)) {
            record.providerSessionId = payload.session_id;
          }
          const observationDir = path.dirname(observationPath);
          // Only a real directory owned by this account folder: a symlink here would send the record
          // wherever it points. Created private (0700); an existing one is tightened to match.
          fs.mkdirSync(observationDir, { recursive: true, mode: 0o700 });
          const dirInfo = fs.lstatSync(observationDir);
          if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('observation-dir-not-a-directory');
          if (process.platform !== 'win32') fs.chmodSync(observationDir, 0o700);
          const tempFile = `${observationPath}.tmp.${randomUUID()}`;
          fs.writeFileSync(tempFile, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
          fs.renameSync(tempFile, observationPath);
        }
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

module.exports = { runBridge, SESSION_ID_ENV };
