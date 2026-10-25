'use strict';

/**
 * What the person is told when the privacy scan stops a comment, a review or another post (#389): which kind of private data it
 * contains and where that data is kept here, and what to do. Never the value itself: a finding carries only its category and the
 * caller's id, and the id names a collection and a field (`profiles:<hash>:email`), not what is stored. Pure; nothing is logged.
 */

// Where a private value the extension keeps comes from, by collection; a field can say more.
const COLLECTION_WORDS = Object.freeze({
  profiles: 'a detail of one of your accounts (Accounts tab)',
  accountChecks: 'a detail of one of your accounts (Accounts tab)',
  roleGroups: 'a role group\'s name, instructions or settings',
  sessions: 'a detail of an agent session (its name, folder or command)',
  reportFeedback: 'your private note on a report (kept only on this machine)',
  broadcasts: 'the text of a broadcast you sent to agents',
  broadcastDeliveries: 'the text of a broadcast you sent to agents',
  teamRules: 'a team rule',
  skills: 'a skill in the Knowledge tab',
  taskDispatches: 'a task you sent to an agent',
  usageLog: 'a record of the usage log',
  quotaReservations: 'a record of account usage',
  researchConsents: 'a research consent record',
  codenames: 'an agent codename record',
  ownerPosts: 'a record of your own posts',
  policies: 'a private setting'
});
const FIELD_WORDS = Object.freeze({
  email: 'an account e-mail address (Accounts tab)',
  organization: 'an account organization name (Accounts tab)',
  label: 'an account name (Accounts tab)',
  note: 'your private note on a report (kept only on this machine)'
});
const CATEGORY_WORDS = Object.freeze({
  credential: 'something that looks like a password, token or key',
  identifier: 'an e-mail address or an id that could name a person or a session',
  'local-path': 'a folder or file path of this computer',
  'file-name': 'a file name that usually holds private data',
  unscannable: 'something that could not be checked'
});
const FRAGMENT_WORDS = 'text repeated from a private note, rule or memory';

function describe(finding) {
  if (!finding || typeof finding !== 'object') return 'something private';
  const id = typeof finding.id === 'string' ? finding.id : '';
  const [collection, , field = ''] = id.split(':');
  const last = field.split('.').filter((part) => !/^\d+$/.test(part)).pop() ?? '';
  if (finding.category === 'known-value' || finding.category === 'private-fragment') {
    if (collection === 'profiles' || collection === 'accountChecks') {
      if (Object.hasOwn(FIELD_WORDS, last) && last !== 'note') return FIELD_WORDS[last];
      if (last === 'name') return FIELD_WORDS.label;
    }
    if (Object.hasOwn(COLLECTION_WORDS, collection)) return COLLECTION_WORDS[collection];
    return finding.category === 'private-fragment' ? FRAGMENT_WORDS : 'a value kept privately on this machine';
  }
  return Object.hasOwn(CATEGORY_WORDS, finding.category) ? CATEGORY_WORDS[finding.category] : 'something private';
}

/**
 * One sentence for the message: "It contains an account e-mail address (Accounts tab) and a folder or file path of this computer.
 * Remove or reword that part and try again." Empty when nothing was said about what was found.
 */
function blockedSentence(found) {
  const kinds = [...new Set((Array.isArray(found) ? found : []).map(describe))];
  if (kinds.length === 0) return '';
  const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
  return ` It contains ${list}. Remove or reword that part and try again; nothing was sent.`;
}

module.exports = { describe, blockedSentence, COLLECTION_WORDS, FIELD_WORDS, CATEGORY_WORDS };
