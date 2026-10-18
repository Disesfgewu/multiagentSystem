'use strict';

// The rule id prefix `broadcast:` stands for an administrator broadcast. Typed or stored rules may
// never use it, because a rule that carried such an id would be shown next to real notices and could
// pre-register the id of a future broadcast to make composition fail. Only the object returned by
// `broadcastRule` (src/broadcast/model.js) is allowed to carry it: it is registered here by identity,
// so a copy, a JSON round trip or any value read from storage or from a workspace is not.
const BROADCAST_ID_PREFIX = 'broadcast:';
const issued = new WeakSet();

function markIssuedBroadcastRule(rule) {
  issued.add(rule);
  return rule;
}

function isIssuedBroadcastRule(rule) {
  return rule !== null && typeof rule === 'object' && issued.has(rule);
}

module.exports = { BROADCAST_ID_PREFIX, markIssuedBroadcastRule, isIssuedBroadcastRule };
