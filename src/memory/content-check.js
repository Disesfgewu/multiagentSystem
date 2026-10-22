'use strict';

const { checkPromptInjection } = require('../research/ethics');
const { OWN_MARKER } = require('../shared/markers');

/**
 * What a note's TEXT may not contain, because it is written into an agent's instructions as one list line. A suggestion can come from an
 * agent, so its text is not trusted: it may not contain a line break (it could open a new section of the instructions), any control,
 * invisible or direction-changing character, wording that tells the agent to ignore its rules, or this package's own message markers.
 * Checked when a note is proposed AND again when notes are chosen for an agent, so a note stored earlier is checked too.
 * @returns {null | 'unsafe-characters' | 'injection-suspected' | 'marker-forged'} the first problem, or null when the text is fine
 */
function contentProblem(text) {
  if (typeof text !== 'string') return 'unsafe-characters';
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return 'unsafe-characters';
  if (OWN_MARKER.test(text.replace(/\s+/g, ' '))) return 'marker-forged';
  let injected;
  try { injected = checkPromptInjection(text).hasInjection; } catch { return 'injection-suspected'; }
  return injected ? 'injection-suspected' : null;
}

module.exports = { contentProblem };
