'use strict';

const { builtIn } = require('../providers/registry');
const { parseCodename } = require('./codenames');

/**
 * The one line an agent's terminal shows instead of the long command typed into it (#357). It is built only from fixed words, the
 * name of a built-in provider (never a custom provider's id, which the person typed) and a codename in the issued form; nothing
 * from the person, a role group or GitHub goes into it. formatClearPrefix checks the characters once more before it is typed.
 */
function launchNote(provider, codename, registry = builtIn) {
  const known = typeof provider === 'string' && registry.has(provider) ? registry.get(provider)?.label : undefined;
  const cli = typeof known === 'string' && /^[A-Za-z0-9 ]{1,30}$/.test(known) ? known : 'an agent CLI';
  // A codename exactly as this extension gives them out (the same check as everywhere else).
  const code = parseCodename(codename) ? ` (${codename})` : '';
  return `Multiagent: starting ${cli}${code}`;
}

module.exports = { launchNote };
