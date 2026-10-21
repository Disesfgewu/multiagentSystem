'use strict';

const { randomUUID } = require('node:crypto');
const { validRecord } = require('./role-store');

const LAYERS = ['platform', 'user', 'project', 'roleGroup', 'task'];
const { TOOLS } = require('./role-group');
const LEVELS = ['deny', 'ask', 'allow'];
const fail = (reason) => ({ ok: false, reason });

/** Apply a single editor choice to a copy, validating the complete result before it can be saved. */
function editRoleRecord(record, change, { newId = randomUUID } = {}) {
  if (!validRecord(record)) return fail('invalid-role-record');
  if (!change || typeof change !== 'object' || typeof change.kind !== 'string') return fail('invalid-edit');
  const next = structuredClone(record);
  const group = next.group;
  switch (change.kind) {
    case 'rename':
      group.name = change.name;
      break;
    case 'tool':
      if (!TOOLS.includes(change.tool) || !LEVELS.includes(change.level)) return fail('invalid-edit');
      group.toolPermissions[change.tool] = change.level;
      break;
    case 'account':
      group.defaultAccountProfileId = change.profileId;
      break;
    case 'memory':
      group.memoryScope = { mode: change.mode };
      break;
    case 'repositories':
    case 'paths':
      group.allowedScope[change.kind] = change.entries;
      break;
    case 'pm-template':
      if (group.role !== 'pm' || typeof change.text !== 'string' || !change.text.trim()) return fail('invalid-edit');
      group.rules = group.rules.filter((rule) => rule.id !== 'pm-system-prompt');
      group.rules.push({ id: 'pm-system-prompt', type: 'instruction', text: change.text, version: 1 });
      break;
    case 'add':
    case 'edit':
    case 'remove': {
      if (!LAYERS.includes(change.layer)) return fail('invalid-edit');
      const rules = change.layer === 'roleGroup' ? group.rules : (next.layers[change.layer] ??= []);
      const index = rules.findIndex((rule) => rule.id === change.ruleId && rule.type === 'instruction');
      if (change.kind !== 'add' && index < 0) return fail('rule-not-found');
      if (change.kind === 'remove') rules.splice(index, 1);
      else if (change.kind === 'edit') {
        rules[index].text = change.text;
        rules[index].version += 1;
      } else rules.push({ id: `instruction-${newId()}`, type: 'instruction', text: change.text, version: 1 });
      break;
    }
    default:
      return fail('invalid-edit');
  }
  group.version += 1;
  if (!validRecord(next)) return fail('invalid-edit');
  return { ok: true, record: next };
}

module.exports = { editRoleRecord };
