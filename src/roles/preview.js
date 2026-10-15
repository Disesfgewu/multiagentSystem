'use strict';

const crypto = require('node:crypto');
const { LAYERS, byCodeUnit, resolveRules } = require('../memory/rules');
const { isPlainObject, label, validateRuleList } = require('./rule-input');
const { TOOLS, validateRoleGroup } = require('./role-group');

// The layers a caller supplies. The role group's own layer comes from the group,
// so it cannot be passed in here as well.
const SUPPLIED_LAYERS = Object.freeze(LAYERS.filter((layer) => layer !== 'roleGroup'));
const strength = (layer) => LAYERS.indexOf(layer);

// What this module can and cannot enforce. It composes and shows the rules; the
// CLIs are only told about them. Nothing here is claimed to be enforced.
const ENFORCEMENT = Object.freeze({ enforced: false, by: 'broker-or-isolation' });

const derivedId = (group, kind, tool) => `rg:${group.id}:${kind}:${tool}`;
const toolKey = (tool) => `tool:${tool}`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// A group's tool permissions, expressed as rules at the role-group layer so they
// are composed by the same resolver as every other rule. `deny` forbids the tool,
// `ask` tells the model to ask first, `allow` adds nothing: it can never override
// a stronger layer's forbid.
function derivedRules(group) {
  const out = [];
  for (const tool of TOOLS) {
    const level = group.toolPermissions[tool];
    if (level === 'deny') {
      out.push({ id: derivedId(group, 'deny', tool), layer: 'roleGroup', type: 'forbid', key: toolKey(tool), version: group.version });
    } else if (level === 'ask') {
      out.push({
        id: derivedId(group, 'ask', tool), layer: 'roleGroup', type: 'instruction',
        text: `Ask the user before using ${tool}.`, version: group.version
      });
    }
  }
  return out;
}

// Builds the effective configuration a session would start with, or says why it
// cannot. Rules are composed by `resolveRules`; this adds validation, the source
// layer and version of everything shown, and the tool permissions that result.
//
// Nothing is written anywhere, and no file in a repository is created or changed.
function previewEffectiveRules({ roleGroup, layers } = {}) {
  const checked = validateRoleGroup(roleGroup);
  if (!checked.ok) return { ok: false, problems: checked.problems };
  const group = checked.group;

  const problems = [];
  const supplied = layers === undefined ? {} : layers;
  if (!isPlainObject(supplied)) return { ok: false, problems: [{ code: 'invalid-layers', path: 'layers' }] };
  for (const name of Object.keys(supplied)) {
    if (!SUPPLIED_LAYERS.includes(name)) problems.push({ code: 'unknown-layer', path: `layers.${label(name)}` });
  }

  const entries = [];
  for (const layer of SUPPLIED_LAYERS) {
    const list = validateRuleList(supplied[layer], { layer, path: `layers.${layer}` });
    for (const problem of list.problems) problems.push({ code: problem.code, path: problem.path, layer: problem.layer });
    for (const rule of list.rules) entries.push({ ...rule, layer });
  }
  for (const rule of group.rules) entries.push({ ...rule, layer: 'roleGroup' });
  entries.push(...derivedRules(group));

  // One id means one rule. Letting two layers reuse an id would make the resolver
  // pick a winner silently; here it is an error the author has to fix.
  const seen = new Map();
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push({ code: 'duplicate-id', path: entry.id, layer: entry.layer, other: seen.get(entry.id) });
    else seen.set(entry.id, entry.layer);
  }
  if (problems.length > 0) return { ok: false, problems };

  try {
    return compose(group, entries);
  } catch {
    return { ok: false, problems: [{ code: 'internal-error', path: '' }] };
  }
}

function compose(group, entries) {
  // `resolveRules` orders its input by layer and then by id (by code unit), so the result
  // and its digest do not depend on the order the rules were given.
  const resolved = resolveRules(entries);
  if (resolved.conflicts.some((conflict) => conflict.code === 'invalid-rule' || conflict.code === 'duplicate-id')) {
    return { ok: false, problems: [{ code: 'resolver-rejected-rule', path: '' }] };
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ref = (id) => {
    const entry = byId.get(id);
    return { id, layer: entry.layer, version: entry.version ?? null };
  };

  const conflicts = resolved.conflicts.map((conflict) => {
    const out = { code: conflict.code, rule: conflict.rule, target: conflict.target };
    const source = ref(conflict.rule);
    out.layer = source.layer;
    out.version = source.version;
    if (conflict.target) {
      const target = ref(conflict.target);
      out.targetLayer = target.layer;
      out.targetVersion = target.version;
    }
    return out;
  });

  // A tool is effectively denied if any accepted rule forbids it, whatever layer
  // that rule came from. A group's `allow` therefore never widens anything.
  const permissions = TOOLS.map((tool) => {
    const declared = group.toolPermissions[tool];
    const own = derivedId(group, 'deny', tool);
    const limitedBy = resolved.forbids
      .filter((rule) => rule.key === toolKey(tool) && rule.id !== own)
      .map((rule) => ref(rule.id));
    const stronger = limitedBy.filter((source) => strength(source.layer) < strength('roleGroup'));
    const relaxationBlocked = declared !== 'deny' && stronger.length > 0;
    if (relaxationBlocked) {
      for (const source of stronger) {
        conflicts.push({
          code: 'permission-relaxation-blocked', tool, declared,
          target: source.id, targetLayer: source.layer, targetVersion: source.version
        });
      }
    }
    return {
      tool,
      declared,
      effective: declared === 'deny' || limitedBy.length > 0 ? 'deny' : declared,
      limitedBy,
      relaxationBlocked,
      ...ENFORCEMENT
    };
  });

  const replaced = resolved.replaced.map((entry) => ({ rule: ref(entry.rule), replaced: ref(entry.target) }));

  const roleGroup = {
    id: group.id,
    name: group.name,
    role: group.role,
    provider: group.provider,
    version: group.version,
    defaultAccountProfileId: group.defaultAccountProfileId,
    allowedScope: group.allowedScope,
    memoryScope: group.memoryScope
  };
  // The same shape `renderContext` in src/memory/injection.js takes as `rules`.
  const rules = {
    forbids: resolved.forbids,
    requires: resolved.requires,
    instructions: resolved.instructions,
    conflicts,
    sources: resolved.sources
  };
  // The digest covers what a session would actually be given. Conflicts are
  // explanations of how that was reached, so they are left out of it.
  const effective = { forbids: rules.forbids, requires: rules.requires, instructions: rules.instructions, sources: rules.sources };
  const digest = `sha256:${crypto.createHash('sha256').update(canonicalJson({ roleGroup, rules: effective, permissions })).digest('hex')}`;
  return { ok: true, problems: [], roleGroup, rules, replaced, permissions, digest };
}

// A plain-text view for a person to read. It is shown locally and holds the text
// of the instructions, so it must not be pasted into GitHub or logs.
//
// `options.injection` is the result of `injectionStatus`. When it is given, every rule and every tool
// permission is tagged with what happened to it, and the header says so. A rule is never shown as
// applied unless the status says evidence was recorded.
function formatPreview(preview, options = {}) {
  if (!preview || preview.ok !== true) {
    const lines = ['Effective configuration cannot be built:'];
    for (const problem of (preview && preview.problems) || []) {
      lines.push(`  - ${problem.code}${problem.layer ? ` [${problem.layer}]` : ''}${problem.path ? ` at ${problem.path}` : ''}`);
    }
    return `${lines.join('\n')}\n`;
  }
  const { roleGroup, rules, replaced, permissions } = preview;
  const list = (items) => (items.length > 0 ? items.join(', ') : 'none');
  const source = (entry) => `${entry.layer}${entry.version === null ? '' : ` v${entry.version}`}`;
  const sourceOf = new Map(rules.sources.map((entry) => [entry.id, entry]));
  const injection = options && options.injection;
  const short = { 'sent-to-cli': 'sent to the CLI', 'preview-only': 'NOT sent to the CLI', unsupported: 'not supported: give by hand' };
  const tag = injection && Object.hasOwn(short, injection.state) ? `  <${short[injection.state]}>` : '';

  const lines = [
    `Role group: ${roleGroup.name} (${roleGroup.id}; role ${roleGroup.role}; ${roleGroup.provider}; version ${roleGroup.version})`,
    `Default account profile: ${roleGroup.defaultAccountProfileId ?? 'none (choose when creating an agent)'}`,
    `Allowed repositories: ${list(roleGroup.allowedScope.repositories)}`,
    `Allowed paths: ${list(roleGroup.allowedScope.paths)}`,
    `Memory: ${roleGroup.memoryScope.mode}`,
    ...(injection ? [`Rules in the CLI: ${injection.label}`] : []),
    '',
    'Effective rules:'
  ];
  const described = [
    ...rules.forbids.map((rule) => ({ rule, text: `forbid ${rule.key}` })),
    ...rules.requires.map((rule) => ({ rule, text: `require ${rule.key}` })),
    ...rules.instructions.map((rule) => ({ rule, text: `instruction: ${rule.text}` }))
  ].sort((a, b) => strength(a.rule.layer) - strength(b.rule.layer) || byCodeUnit(a.rule.id, b.rule.id));
  if (described.length === 0) lines.push('  (none)');
  for (const { rule, text } of described) lines.push(`  - ${text}  [${source(sourceOf.get(rule.id))}; ${rule.id}]${tag}`);

  lines.push('', 'Tool permissions (declared -> effective; not enforced here, left to broker or isolation):');
  for (const entry of permissions) {
    const limited = entry.limitedBy.length > 0 ? ` limited by ${entry.limitedBy.map((s) => `${s.id} (${source(s)})`).join(', ')}` : '';
    lines.push(`  - ${entry.tool}: ${entry.declared} -> ${entry.effective}${limited}${injection ? '  <told to the agent only, not enforced>' : ''}`);
  }
  if (replaced.length > 0) {
    lines.push('', 'Replaced rules:');
    for (const entry of replaced) lines.push(`  - ${entry.rule.id} (${source(entry.rule)}) replaced ${entry.replaced.id} (${source(entry.replaced)})`);
  }
  if (rules.conflicts.length > 0) {
    lines.push('', 'Blocked or conflicting:');
    for (const conflict of rules.conflicts) {
      const subject = conflict.tool ? `tool ${conflict.tool}` : `${conflict.rule} (${source(conflict)})`;
      const target = conflict.target ? ` against ${conflict.target} (${source({ layer: conflict.targetLayer, version: conflict.targetVersion })})` : '';
      lines.push(`  - ${conflict.code}: ${subject}${target}`);
    }
  }
  lines.push('', `Digest: ${preview.digest}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { previewEffectiveRules, formatPreview, ENFORCEMENT };
