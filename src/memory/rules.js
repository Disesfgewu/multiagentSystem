'use strict';

// Strongest first. A rule from a later layer may add restrictions but can never
// weaken or remove one from an earlier layer.
const LAYERS = Object.freeze(['platform', 'user', 'project', 'roleGroup', 'task']);
const TYPES = Object.freeze(['forbid', 'require', 'instruction']);

const TYPE_ORDER = Object.freeze({ forbid: 0, require: 1, instruction: 2 });

function resolveRules(entries) {
  const conflicts = [];
  const accepted = [];
  const strength = (entry) => LAYERS.indexOf(entry.layer);

  const valid = entries.filter((entry) => {
    const ok = entry && typeof entry.id === 'string' && LAYERS.includes(entry.layer) &&
      TYPES.includes(entry.type) &&
      (entry.type === 'instruction' ? typeof entry.text === 'string' : typeof entry.key === 'string');
    if (!ok) conflicts.push({ code: 'invalid-rule', rule: entry && entry.id ? entry.id : null });
    return ok;
  });

  // Ids must be unique. When several rules share one, the strongest layer wins,
  // then forbid over require over instruction, then a content-based tie-break,
  // so the outcome never depends on input order and a weaker rule cannot hide
  // behind a stronger rule's id.
  const content = (entry) => JSON.stringify([entry.type, entry.key ?? '', entry.text ?? '', entry.replaces ?? '']);
  const groups = new Map();
  for (const entry of valid) {
    if (!groups.has(entry.id)) groups.set(entry.id, []);
    groups.get(entry.id).push(entry);
  }
  const unique = [];
  for (const [id, group] of groups) {
    group.sort((a, b) => strength(a) - strength(b) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      content(a).localeCompare(content(b)));
    unique.push(group[0]);
    for (const dropped of group.slice(1)) {
      conflicts.push({ code: 'duplicate-id', rule: id, layer: dropped.layer });
    }
  }

  // Replacement is applied strongest layer first, and only by rules that are
  // still in force: a rule that was itself replaced or ignored replaces nothing.
  // A rule may replace one from its own or a weaker layer, never a stronger one.
  const ordered = [...unique].sort((a, b) => strength(a) - strength(b) || a.id.localeCompare(b.id));
  const byId = new Map(unique.map((entry) => [entry.id, entry]));
  const removed = new Set();
  const ignored = new Set();
  for (const entry of ordered) {
    if (removed.has(entry.id) || !entry.replaces || entry.replaces === entry.id) continue;
    const target = byId.get(entry.replaces);
    if (!target) continue;
    if (strength(target) < strength(entry)) {
      conflicts.push({ code: 'cannot-replace-stronger-layer', rule: entry.id, target: target.id });
      ignored.add(entry.id);
    } else {
      removed.add(target.id);
    }
  }

  for (const entry of ordered) {
    if (removed.has(entry.id) || ignored.has(entry.id)) continue;
    const opposite = entry.type === 'forbid' ? 'require' : entry.type === 'require' ? 'forbid' : null;
    const clash = opposite && accepted.find((other) => other.type === opposite && other.key === entry.key);
    if (clash) {
      // The stronger (earlier) rule stays; equal layers fail closed on the forbid.
      if (strength(clash) < strength(entry) || entry.type === 'require') {
        conflicts.push({ code: `${entry.type}-vs-${clash.type}`, rule: entry.id, target: clash.id });
        continue;
      }
      accepted.splice(accepted.indexOf(clash), 1);
      conflicts.push({ code: `${clash.type}-vs-${entry.type}`, rule: clash.id, target: entry.id });
    }
    accepted.push(entry);
  }

  const pick = (type) => accepted.filter((entry) => entry.type === type);
  return {
    forbids: pick('forbid').map((entry) => ({ id: entry.id, layer: entry.layer, key: entry.key })),
    requires: pick('require').map((entry) => ({ id: entry.id, layer: entry.layer, key: entry.key })),
    instructions: pick('instruction').map((entry) => ({ id: entry.id, layer: entry.layer, text: entry.text })),
    conflicts,
    sources: accepted.map((entry) => ({ id: entry.id, layer: entry.layer, version: entry.version ?? null }))
  };
}

module.exports = { LAYERS, TYPES, resolveRules };
