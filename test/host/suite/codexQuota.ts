import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accountService } from '../../../src/accounts/accountRuntime';
import { accountTreeForTests } from '../../../src/accounts/accountCommands';
import { privateStorage } from '../../../src/storage/storageCommands';
import { UsageLog } from '../../../src/accounts/usage-log';

/**
 * A Codex account whose CODEX_HOME holds a synthetic session log (written here, fresh): the account row expands into both usage
 * windows read from that log, and the last request's token counts are kept once in the usage log however often the row is read.
 * Nothing runs Codex; the log is a file this test writes in the shape documented in src/accounts/codex-rate-limits.js.
 */
export async function runCodexQuotaChecks(workspace: string): Promise<void> {
  const home = path.join(path.dirname(workspace), 'synthetic-codex-home');
  const day = new Date();
  const folder = path.join(home, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  fs.writeFileSync(path.join(folder, 'rollout-synthetic-host-1.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { note: 'SYNTHETIC-PROMPT-MUST-NOT-APPEAR' } })}\n${JSON.stringify({
    timestamp: new Date(Date.now() - 20_000).toISOString(), type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 700, cached_input_tokens: 500, cache_write_input_tokens: 0, output_tokens: 120 } },
      rate_limits: { primary: { used_percent: 37, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: reset + 3 * 86400 }, plan_type: 'plus' }
    }
  })}\n`);
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const created = accounts.service.create({ provider: 'codex', label: 'Host Codex Account', configDir: home });
  assert.ok(created.ok, JSON.stringify(created));
  if (!created.ok) return;
  try {
    const tree = accountTreeForTests();
    const row = ((await tree.getChildren()) ?? []).find((entry) => entry.label === 'Host Codex Account');
    assert.ok(row, 'the Codex account is listed');
    const expanded = (await tree.getChildren(row as any)) ?? [];
    const text = expanded.map((entry) => String(entry.label)).join('\n');
    assert.match(text, /Usage \(five_hour\): 37% used, verified and current/, 'the 5-hour window comes from the Codex log');
    assert.match(text, /Usage \(seven_day\): 12% used/, 'and the weekly window');
    assert.match(text, /Plan: plus \(reported by the Codex session log\)/);
    assert.equal(text.includes('SYNTHETIC-PROMPT-MUST-NOT-APPEAR'), false, 'nothing but the numbers is shown');
    assert.ok(expanded.some((entry) => entry.label === 'Token usage log'), 'the link to the usage log is there');
    await tree.getChildren(row as any);
    await tree.getChildren(row as any);

    const opened = await privateStorage()?.use();
    assert.ok(opened?.ok);
    const entries = (new UsageLog(opened.store).query({ accountProfileId: created.profile.id }) as { entries: Array<{ provider: string; inputTokens: number; cacheReadTokens: number; outputTokens: number; source: string; measurement: string }> }).entries;
    assert.equal(entries.length, 1, 'the same event is kept once, however often the row is read');
    assert.deepEqual([entries[0].provider, entries[0].inputTokens, entries[0].cacheReadTokens, entries[0].outputTokens, entries[0].source, entries[0].measurement], ['codex', 700, 500, 120, 'codex-session-log', 'actual']);
  } finally {
    await accounts.service.remove(created.profile.id);
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log('host smoke: a Codex account row shows both usage windows and the plan read from its own session log, and the last request is kept once in the usage log');
}
