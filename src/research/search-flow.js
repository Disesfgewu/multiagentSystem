'use strict';

/**
 * "Search papers" run by the person, from inside the extension (issue #61). The person chooses which running research
 * server and which of its search tools, types the query, confirms, and reads the result on screen. Nothing here sends
 * anything to an agent, a terminal, a session or GitHub: the person may copy the result and hand it over themselves.
 *
 * Only what the lifecycle already allows is offered: a server that is running, whose tool the researcher role is
 * granted (`authorize`), and whose name says it is a search (`search_…`). The query goes through the lifecycle's own
 * `callTool`, which checks the grant again, runs the outbound-query guard, and returns the reply only inside the
 * untrusted-data block (prompt-injection check and size limit). The flow never touches a raw reply.
 *
 * The person's choices come from `ui`. `given` stands in for them only when the caller says it is a test: the command
 * layer passes it solely in Extension Host test mode.
 */

const QUERY_TOOL = /^search_[a-z0-9_]{1,40}$/;
const MAX_QUERY_CHARS = 500;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The running servers' search tools that the researcher role may call right now. */
async function searchChoices(lifecycle) {
  let all;
  try { all = await lifecycle.statusAll(); } catch { return []; }
  const choices = [];
  for (const entry of Array.isArray(all) ? all : []) {
    if (!isPlain(entry) || entry.state !== 'running' || !Array.isArray(entry.allowedTools)) continue;
    for (const tool of entry.allowedTools) {
      if (typeof tool !== 'string' || !QUERY_TOOL.test(tool)) continue;
      let decision;
      try { decision = lifecycle.authorize({ role: 'researcher', serverId: entry.serverId, tool }); } catch { decision = null; }
      if (decision && decision.allowed === true) choices.push({ serverId: entry.serverId, tool });
    }
  }
  return choices;
}

function validQuery(query) {
  return typeof query === 'string' && query.trim() !== '' && Array.from(query).length <= MAX_QUERY_CHARS && !UNSAFE_TEXT.test(query);
}

/**
 * @param {{
 *   lifecycle: { statusAll(): Promise<object[]>, authorize(input: object): { allowed: boolean }, callTool(input: object): Promise<object> },
 *   ui: { pick(choices: Array<{ serverId: string, tool: string }>): Promise<{ serverId: string, tool: string } | undefined>, promptQuery(): Promise<string | undefined>, confirm(text: string): Promise<boolean>, show(result: object): Promise<void> | void },
 *   given?: { serverId?: unknown, tool?: unknown, query?: unknown }
 * }} input
 * @returns {Promise<{ ok: true, truncated: boolean } | { ok: false, code: string }>}
 */
async function runSearchFlow({ lifecycle, ui, given } = {}) {
  const choices = await searchChoices(lifecycle);
  if (choices.length === 0) return fail('no-search-tool-available');

  let chosen;
  if (given) {
    chosen = choices.find((choice) => choice.serverId === given.serverId && choice.tool === given.tool);
    if (!chosen) return fail('not-available');
  } else {
    chosen = await ui.pick(choices);
    if (!chosen) return fail('cancelled');
    // Whatever the picker returned, only an offered choice counts.
    chosen = choices.find((choice) => choice.serverId === chosen.serverId && choice.tool === chosen.tool);
    if (!chosen) return fail('not-available');
  }

  const query = given ? given.query : await ui.promptQuery();
  if (query === undefined) return fail('cancelled');
  if (!validQuery(query)) return fail('invalid-query');

  if (!given) {
    const confirmed = await ui.confirm(`Search “${chosen.tool}” on ${chosen.serverId} for:\n\n${query}\n\nThe query is sent to the research server, which may contact outside services. The result is shown to you only; nothing is sent to an agent, a terminal or GitHub.`);
    if (confirmed !== true) return fail('cancelled');
  }

  let reply;
  try { reply = await lifecycle.callTool({ role: 'researcher', serverId: chosen.serverId, tool: chosen.tool, args: { query } }); } catch { return fail('internal-error'); }
  if (!isPlain(reply) || reply.ok !== true || typeof reply.payload !== 'string') return fail(isPlain(reply) && typeof reply.code === 'string' ? reply.code : 'internal-error');
  await ui.show({ payload: reply.payload, truncated: reply.truncated === true, source: reply.source });
  return { ok: true, truncated: reply.truncated === true };
}

module.exports = { runSearchFlow, searchChoices, QUERY_TOOL, MAX_QUERY_CHARS };
