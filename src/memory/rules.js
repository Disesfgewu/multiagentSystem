'use strict';

// Strongest first. A rule from a later layer may add restrictions but can never
// weaken or remove one from an earlier layer.
const LAYERS = Object.freeze(['platform', 'user', 'project', 'roleGroup', 'task']);
const TYPES = Object.freeze(['forbid', 'require', 'instruction']);

function resolveRules(entries) {
  const conflicts = [];
  const accepted = [];

  const valid = entries.filter((entry) => {
    const ok = entry && typeof entry.id === 'string' && LAYERS.includes(entry.layer) &&
      TYPES.includes(entry.type) &&
      (entry.type === 'instruction' ? typeof entry.text === 'string' : typeof entry.key === 'string');
    if (!ok) conflicts.push({ code: 'invalid-rule', rule: entry && entry.id ? entry.id : null });
    return ok;
  });

  const strength = (entry) => LAYERS.indexOf(entry.layer);
  const all = new Map(valid.map((entry) => [entry.id, entry]));
  const removed = new Set();
  const ignored = new Set();

  // A rule may replace one from its own or a weaker layer, never a stronger one.
  for (const entry of valid) {
    const target = entry.replaces && all.get(entry.replaces);
    if (!target) continue;
    if (strength(target) < strength(entry)) {
      conflicts.push({ code: 'cannot-replace-stronger-layer', rule: entry.id, target: target.id });
      ignored.add(entry.id);
    } else {
      removed.add(target.id);
    }
  }

  const ordered = valid
    .filter((entry) => !removed.has(entry.id) && !ignored.has(entry.id))
    .sort((a, b) => strength(a) - strength(b));

  for (const entry of ordered) {
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
