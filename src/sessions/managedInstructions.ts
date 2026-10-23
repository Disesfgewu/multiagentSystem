'use strict';

import * as crypto from 'node:crypto';
import { builtIn } from '../providers/registry';
import { renderContext, planInjection, writePlan, cleanupPlan } from '../memory/injection';
import { resolveRules } from '../memory/rules';
import { previewEffectiveRules, formatPreview, ENFORCEMENT } from '../roles/preview';
import { validRecord } from '../roles/role-store';
import { validateRoleGroup } from '../roles/role-group';
import { checkRoleForLaunch } from '../roles/launch-role';
import { BroadcastStore } from '../broadcast/store';
import * as nodePath from 'node:path';
const { MemoryStore } = require('../memory/store') as { MemoryStore: new (options: Record<string, unknown>) => { select(request: Record<string, unknown>): any } };
const { defaultDomainFor } = require('../memory/domains') as { defaultDomainFor(accountProfileId: string): string };
import { TeamRulesStore } from '../teamRules/store';
import { teamRuleLayer, describeTeamRules } from '../teamRules/model';
const { codenameRule, parseCodename, CODENAME_RULE_ID } = require('./codenames') as { codenameRule(codename: string): { id: string; type: 'instruction'; text: string }; parseCodename(value: unknown): { prefix: string; number: number } | null; CODENAME_RULE_ID: string };
import { isLive, appliesTo, broadcastRule, broadcastPreviewLines } from '../broadcast/model';
const { checkPromptInjection, validateResearchDeliverable } = require('../research/ethics') as {
  checkPromptInjection(text: string): { hasInjection: boolean; matches: string[] };
  validateResearchDeliverable(deliverable: unknown, options?: { target?: string }): { ok: boolean; code: string; problems?: Array<{ code: string; message: string }> };
};

export interface BroadcastBinding {
  id: string;
  version: number;
  expiresAt: string | null;
}

export interface InstructionSnapshot {
  repoRoot: string;
  repoId: string;
  provider: string;
  roleGroupId: string;
  role?: string;
  roleGroupVersion: number | null;
  accountProfileId: string;
  requestedModel: string | null;
  targetSessionId: string;
  broadcastBindings: BroadcastBinding[];
  /** The shared notes this snapshot was composed with (id and version). A change to any of them makes the snapshot stale. */
  memoryBindings: Array<{ id: string; version: number }>;
  /** The version of the team rules this snapshot was composed with (0: none were written). A newer version makes the snapshot stale. */
  teamRulesVersion: number;
  /** The session's codename (issue #342), which the agent is told to sign its GitHub posts with; null when it has none. */
  codename: string | null;
  digest: string | null;
  createdAt: string;
}

export interface PrepareInstructionsOptions {
  store: any;
  repoRoot: string;
  repoId: string;
  provider: string;
  roleGroupId?: string;
  accountProfileId?: string;
  requestedModel?: string | null;
  targetSessionId: string;
  now?: Date;
  privateDir: string;
  codexHome?: string;
  context?: any;
  /** The session's codename (issue #342). When given, the agent is told it and how to sign: an instruction ahead of the team rules. */
  codename?: string;
}

export interface PreparedInstructions {
  ok: true;
  snapshot: InstructionSnapshot;
  plan: any | null;
  digest: string | null;
  /**
   * The digest of what the person reviews (#362): the same inputs as `digest` but with this session's codename taken out, so two
   * agents of one role group with the same rules, notices and notes have the same review digest although each has its own codename.
   */
  reviewDigest: string | null;
  method: string;
  argv: string[];
  injectionState: 'prepared' | 'launch-requested' | 'manual' | 'unsupported' | 'none';
  injectionStatusLabel: string;
  renderedContext: string | null;
  summaryText: string;
  /** The role group's effective level for each tool (a stronger layer's ban applied), or null without a role group: what the launch turns into the CLI's own permission settings (issue #310). */
  toolPermissions: Record<string, string> | null;
  /** How many rules and shared notes were put into the prepared instructions (prepared, not proof that the CLI read them). */
  injectedCounts: { rules: number; memories: number };
}

export interface PrepareInstructionsFailure {
  ok: false;
  code: string;
  message: string;
  problems?: any[];
}

export type PrepareInstructionsResult = PreparedInstructions | PrepareInstructionsFailure;

export interface CheckStaleOptions {
  store: any;
  repoRoot: string;
  now?: Date;
}

export interface StaleResult {
  stale: boolean;
  reason?: string;
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Prepares the shared effective instruction snapshot for a session about to start or reopen.
 *
 * All launch and reopen paths must use this function so that the instructions shown in UI preview,
 * checked by the user, and handed to the CLI via native terminal are guaranteed identical.
 */
export async function prepareInstructionSnapshot(
  options: PrepareInstructionsOptions
): Promise<PrepareInstructionsResult> {
  const { store, repoRoot, repoId, provider, targetSessionId, privateDir } = options;
  const now = options.now ?? new Date();

  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    return { ok: false, code: 'invalid-repo-root', message: 'Worktree path is required.' };
  }
  if (!SESSION_TOKEN.test(targetSessionId)) {
    return { ok: false, code: 'invalid-session-token', message: 'Invalid target session token.' };
  }
  if (!builtIn.has(provider)) {
    return { ok: false, code: 'provider-unsupported', message: `Provider "${provider}" is not supported.` };
  }
  if (typeof privateDir !== 'string' || privateDir.trim() === '') {
    return { ok: false, code: 'invalid-private-dir', message: 'Private storage directory is required.' };
  }
  if (options.codename !== undefined && !parseCodename(options.codename)) {
    return { ok: false, code: 'invalid-codename', message: 'The session codename is not valid.' };
  }

  let group: any = null;
  let layers: Record<string, any[]> = {};

  // Step 1: Resolve Role Group if assigned
  if (options.roleGroupId && options.roleGroupId !== 'unassigned') {
    const loaded = store.get('roleGroups', options.roleGroupId);
    if (!loaded?.ok || !loaded.found) {
      return { ok: false, code: 'role-group-not-found', message: 'That role group no longer exists.' };
    }
    const checked: any = checkRoleForLaunch({ id: options.roleGroupId, provider, record: loaded.value });
    if (!checked.ok) {
      return { ok: false, code: checked.code ?? 'invalid-role-group', message: checked.message ?? 'Invalid role group.' };
    }
    group = checked.group;
    layers = loaded.value.layers ?? {};
  }

  // Step 2: Read Broadcast Notices
  const broadcastStore = new BroadcastStore(store);
  const listedBroadcasts: any = broadcastStore.list();
  if (!listedBroadcasts.ok) {
    return { ok: false, code: 'broadcast-storage-unavailable', message: `Broadcast store unavailable (${listedBroadcasts.reason ?? 'unknown'}).` };
  }

  const matchingBroadcasts: any[] = [];
  const broadcastBindings: BroadcastBinding[] = [];

  for (const b of (listedBroadcasts.items ?? [])) {
    if (!isLive(b, now)) continue;
    // Crucial: appliesTo checks session ID only against targetSessionId; an old session broadcast never matches!
    if (!appliesTo(b, { role: group?.role, provider, agentId: targetSessionId })) continue;
    matchingBroadcasts.push(b);
    broadcastBindings.push({ id: b.id, version: b.version, expiresAt: b.expiresAt ?? null });
  }

  const broadcastRules = matchingBroadcasts.map(broadcastRule);

  // Team rules: given to every agent, ahead of its role group's own user-layer rules. If they cannot be read the launch is refused:
  // an agent must not start without rules it is supposed to have because a file was damaged.
  const teamLoaded: any = new TeamRulesStore(store).get();
  if (!teamLoaded.ok) {
    return { ok: false, code: 'team-rules-unavailable', message: `Team rules could not be read (${teamLoaded.reason ?? 'unknown'}). The agent was not started.` };
  }
  // The codename instruction comes first, then the team rules: both are `user`-layer instructions every agent is given.
  const teamRules: any[] = [...(options.codename !== undefined ? [codenameRule(options.codename)] : []), ...teamRuleLayer(teamLoaded.doc)];
  const teamRulesVersion: number = teamLoaded.doc.version;

  // Step 3: Compose Effective Rules and Digest
  let effectiveRules: any = null;
  let permissions: any[] = [];
  let digest: string | null = null;
  let previewResult: any = null;

  if ((options as any).researchFindings !== undefined) {
    const deliverableCheck = validateResearchDeliverable((options as any).researchFindings, { target: 'instructions' });
    if (!deliverableCheck.ok) {
      return { ok: false, code: deliverableCheck.code, message: 'External research findings cannot be elevated into session instructions.', problems: deliverableCheck.problems };
    }
  }

  if (group) {
    const userLayer = [...teamRules, ...(layers.user ?? []), ...broadcastRules];
    const combinedLayers = { ...layers, user: userLayer };
    previewResult = previewEffectiveRules({ roleGroup: group, layers: combinedLayers });
    if (!previewResult.ok) {
      const hasInjection = (previewResult.problems ?? []).some((p: any) => p.code === 'prompt-injection-detected');
      return {
        ok: false,
        code: hasInjection ? 'prompt-injection-detected' : 'rule-composition-failed',
        message: hasInjection ? 'Adversarial prompt injection detected in effective instructions.' : 'Failed to compose effective rules.',
        problems: previewResult.problems
      };
    }
    effectiveRules = previewResult.rules;
    permissions = previewResult.permissions;
    digest = previewResult.digest;
  } else if (broadcastRules.length > 0 || teamRules.length > 0) {
    const ungrouped = [...teamRules.map((rule) => ({ ...rule, layer: 'user' })), ...broadcastRules];
    for (const bRule of ungrouped) {
      if (typeof bRule.text === 'string' && checkPromptInjection(bRule.text).hasInjection) {
        return {
          ok: false,
          code: 'prompt-injection-detected',
          message: 'Adversarial prompt injection detected in team or broadcast instructions.'
        };
      }
    }
    const resolved = resolveRules(ungrouped);
    effectiveRules = {
      forbids: resolved.forbids,
      requires: resolved.requires,
      instructions: resolved.instructions,
      sources: resolved.sources,
      conflicts: resolved.conflicts
    };
    permissions = [];
    const canonicalEffective = { rules: effectiveRules, provider };
    digest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalEffective)).digest('hex')}`;
  }

  // Shared memory: reviewed notes of this repository and role group, in this account's privacy domain, only when the role group
  // asks for them (memory scope "role-group"). A memory file that exists but cannot be read stops the launch.
  let memories: any[] = [];
  let memoryOmitted: any;
  if (group && group.memoryScope?.mode === 'role-group') {
    try {
      const memoryStore = new MemoryStore({ dir: nodePath.join(privateDir, 'memory'), repoRoot, now: () => now.getTime() });
      const chosen: any = memoryStore.select({ repoId, roleGroupId: group.id, privacyDomain: defaultDomainFor(options.accountProfileId ?? 'unassigned'), all: true });
      if (chosen.unavailable) return { ok: false, code: 'memory-unavailable', message: `Shared memory could not be read (${chosen.unavailable}). The agent was not started.` };
      memories = chosen.items;
      memoryOmitted = chosen.omitted;
    } catch {
      return { ok: false, code: 'memory-unavailable', message: 'Shared memory could not be opened. The agent was not started.' };
    }
    if (memories.length > 0 && digest !== null) {
      const memoryDigest = crypto.createHash('sha256').update(JSON.stringify(memories.map((item) => [item.id, item.version]))).digest('hex');
      digest = `sha256:${crypto.createHash('sha256').update(`${digest}\n${memoryDigest}`).digest('hex')}`;
    }
  }

  // What the person reviews, without the one rule that differs for every session: the codename instruction (its id is fixed; the
  // codename itself is shown in the dialog anyway). Every other part counts: the provider, the role group (with its tool
  // permissions), each composed rule and the shared notes. The effective permissions follow from the role group and the rules.
  let reviewDigest: string | null = null;
  if (digest !== null) {
    const reviewed = JSON.stringify({ provider, group: group ?? null, rules: effectiveRules, memories: memories.map((item) => [item.id, item.version]) }, (_key, value) => {
      if (Array.isArray(value)) return value.filter((entry) => !(entry && typeof entry === 'object' && (entry as { id?: unknown }).id === CODENAME_RULE_ID));
      return value;
    });
    reviewDigest = `sha256:${crypto.createHash('sha256').update(reviewed).digest('hex')}`;
  }

  // Step 4: Plan and Write Injection Files (strictly in owner directory outside repo)
  let plan: any = null;
  let method = 'none';
  let argv: string[] = [];
  let renderedContext: string | null = null;
  let injectionState: PreparedInstructions['injectionState'] = 'none';
  let injectionStatusLabel = 'No instructions configured';

  if (digest !== null) {
    renderedContext = renderContext({
      roleGroup: group ?? { id: 'unassigned', name: 'Agent', role: 'general' },
      rules: effectiveRules,
      memories,
      omitted: memoryOmitted
    });

    try {
      const ruleInjection = builtIn.capability(provider, 'ruleInjection');
      const canInjectRules = ruleInjection === 'verified' || ruleInjection === 'unverified';

      plan = planInjection({
        provider,
        roleGroup: group ?? { id: 'unassigned', name: 'Agent', role: 'general' },
        rules: effectiveRules,
        memories,
        omitted: memoryOmitted,
        privateDir,
        codexHome: options.codexHome,
        repoRoot,
        sessionToken: targetSessionId,
        capabilities: {
          appendSystemPromptFile: provider === 'claude' && canInjectRules,
          profileFlag: provider === 'codex' && canInjectRules
        },
        context: options.context
      });

      writePlan(plan, options.context);
      method = plan.method;
      argv = plan.argv;

      if (provider === 'claude' && plan.method === 'append-system-prompt-file') {
        injectionState = 'prepared';
        injectionStatusLabel = 'Prepared: will append system prompt file at launch (CLI verification pending)';
      } else if (provider === 'codex' && plan.method === 'profile-developer-instructions') {
        injectionState = 'prepared';
        injectionStatusLabel = 'Prepared: will pass config profile with developer instructions at launch (CLI verification pending)';
      } else if (plan.method === 'manual') {
        injectionState = 'manual';
        injectionStatusLabel = 'Manual: instructions written to private file; paste into terminal';
      } else {
        injectionState = 'unsupported';
        injectionStatusLabel = 'Not supported by this provider: give rules by hand';
      }
    } catch (err: any) {
      if (plan) cleanupPlan(plan);
      return { ok: false, code: 'plan-write-failed', message: `Failed to write private instructions: ${err?.message ?? String(err)}` };
    }
  }

  const snapshot: InstructionSnapshot = {
    repoRoot,
    repoId,
    provider,
    roleGroupId: group ? group.id : 'unassigned',
    role: group?.role,
    roleGroupVersion: group ? group.version : null,
    accountProfileId: options.accountProfileId ?? 'unassigned',
    requestedModel: options.requestedModel ?? null,
    targetSessionId,
    broadcastBindings,
    memoryBindings: memories.map((item) => ({ id: item.id, version: item.version })),
    teamRulesVersion,
    codename: options.codename ?? null,
    digest,
    createdAt: now.toISOString()
  };

  const summaryText = formatInstructionSummary(snapshot, {
    group,
    previewResult,
    effectiveRules,
    permissions,
    matchingBroadcasts,
    memoryCount: memories.length,
    teamRulesLine: describeTeamRules(teamLoaded.doc),
    injectionStatusLabel,
    injectionState,
    now
  });

  return {
    ok: true,
    snapshot,
    plan,
    digest,
    reviewDigest,
    method,
    argv,
    injectionState,
    injectionStatusLabel,
    renderedContext,
    summaryText,
    injectedCounts: { rules: effectiveRules ? effectiveRules.instructions.length + effectiveRules.forbids.length + effectiveRules.requires.length : 0, memories: memories.length },
    toolPermissions: group && previewResult && previewResult.ok ? Object.fromEntries(previewResult.permissions.map((entry: { tool: string; effective: string }) => [entry.tool, entry.effective])) : null
  };
}

/**
 * Checks whether an earlier prepared instruction snapshot has become stale.
 * If the role group, matching broadcasts, or workspace changed during review,
 * launching with the old snapshot must be refused.
 */
export async function isSnapshotStale(
  snapshot: InstructionSnapshot,
  options: CheckStaleOptions
): Promise<StaleResult> {
  const { store, repoRoot } = options;
  const now = options.now ?? new Date();

  if (repoRoot !== snapshot.repoRoot) {
    return { stale: true, reason: 'workspace-changed' };
  }

  if (snapshot.roleGroupId !== 'unassigned') {
    const loaded = store.get('roleGroups', snapshot.roleGroupId);
    if (!loaded?.ok || !loaded.found) {
      return { stale: true, reason: 'role-group-removed' };
    }
    const currentVersion = loaded.value?.group?.version;
    if (currentVersion !== snapshot.roleGroupVersion) {
      return { stale: true, reason: 'role-group-modified' };
    }
  }

  // A shared note changed, was disabled or was added since the snapshot: the agent would start with notes the person did not review.
  if (snapshot.roleGroupId !== 'unassigned') {
    try {
      const loadedGroup = store.get('roleGroups', snapshot.roleGroupId);
      if (loadedGroup?.ok && loadedGroup.found && loadedGroup.value?.group?.memoryScope?.mode === 'role-group') {
        const memoryStore = new MemoryStore({ dir: nodePath.join(store.dir, 'memory'), repoRoot, now: () => now.getTime() });
        const chosen: any = memoryStore.select({ repoId: snapshot.repoId, roleGroupId: snapshot.roleGroupId, privacyDomain: defaultDomainFor(snapshot.accountProfileId), all: true });
        if (chosen.unavailable) return { stale: true, reason: 'memory-unavailable' };
        const now2 = JSON.stringify(chosen.items.map((item: any) => [item.id, item.version]));
        if (now2 !== JSON.stringify((snapshot.memoryBindings ?? []).map((item) => [item.id, item.version]))) return { stale: true, reason: 'memory-changed' };
      } else if ((snapshot.memoryBindings ?? []).length > 0) return { stale: true, reason: 'memory-changed' };
    } catch { return { stale: true, reason: 'memory-unavailable' }; }
  }
  // Team rules changed since the snapshot was prepared: the agent would start with rules the person did not review.
  const team: any = new TeamRulesStore(store).get();
  if (!team.ok) return { stale: true, reason: 'team-rules-unavailable' };
  if (team.doc.version !== (snapshot.teamRulesVersion ?? 0)) return { stale: true, reason: 'team-rules-changed' };

  const broadcastStore = new BroadcastStore(store);
  const listed: any = broadcastStore.list();
  if (!listed.ok) {
    return { stale: true, reason: 'broadcast-storage-unavailable' };
  }
  const currentItems = listed.items ?? [];
  const currentById = new Map<string, any>(currentItems.map((b: any) => [b.id, b]));

  // Check previously bound broadcasts
  for (const binding of snapshot.broadcastBindings) {
    const item = currentById.get(binding.id);
    if (!item) {
      return { stale: true, reason: 'broadcast-removed' };
    }
    if (!isLive(item, now)) {
      return { stale: true, reason: item.revokedAt !== null ? 'broadcast-revoked' : 'broadcast-expired' };
    }
    if (item.version !== binding.version) {
      return { stale: true, reason: 'broadcast-version-changed' };
    }
  }

  // Check if any new live broadcast now matches
  const boundIds = new Set(snapshot.broadcastBindings.map((b) => b.id));
  for (const item of currentItems) {
    if (boundIds.has(item.id)) continue;
    if (!isLive(item, now)) continue;
    if (appliesTo(item, { role: snapshot.role, provider: snapshot.provider, agentId: snapshot.targetSessionId })) {
      return { stale: true, reason: 'broadcast-added' };
    }
  }

  return { stale: false };
}

/**
 * Cleans up the private files and directories created for a session instruction plan.
 */
export function cleanupSessionPlan(plan: any): { removed: number; skipped: any[] } {
  if (!plan) return { removed: 0, skipped: [] };
  return cleanupPlan(plan);
}

/**
 * Formats a plain-text human-readable view of the instruction snapshot for inspection.
 */
export function formatInstructionSummary(
  snapshot: InstructionSnapshot,
  details: {
    group?: any;
    previewResult?: any;
    effectiveRules?: any;
    permissions?: any[];
    matchingBroadcasts?: any[];
    memoryCount?: number;
    teamRulesLine?: string;
    injectionStatusLabel?: string;
    injectionState?: PreparedInstructions['injectionState'];
    now: Date;
  }
): string {
  const lines: string[] = [
    'PRIVATE — local agent instructions snapshot. Do not publish this document.',
    `Session ID: ${snapshot.targetSessionId}`,
    `Codename: ${snapshot.codename ?? 'none'}${snapshot.codename ? ' (the agent is told to sign every GitHub post with it; a signature is a claim, not proof)' : ''}`,
    `Provider: ${snapshot.provider}`,
    `Role group: ${snapshot.roleGroupId}${snapshot.roleGroupVersion !== null ? ` (v${snapshot.roleGroupVersion})` : ' (none)'}`,
    `Account profile: ${snapshot.accountProfileId}`,
    `Requested model: ${snapshot.requestedModel ?? 'CLI default'}`,
    `Delivery: ${details.injectionStatusLabel ?? 'unknown'}`,
    `Digest: ${snapshot.digest ?? 'none'}`,
    `Prepared at: ${snapshot.createdAt}`,
    ''
  ];

  lines.push(`Shared memory: ${details.memoryCount ? `${details.memoryCount} reviewed note${details.memoryCount === 1 ? '' : 's'} prepared for this agent` : 'none prepared for this agent'}. The CLI is told; nothing enforces them.`, '');
  if (details.teamRulesLine) lines.push(details.teamRulesLine, '');

  if (details.matchingBroadcasts && details.matchingBroadcasts.length > 0) {
    lines.push('Matching local administrator notices:');
    for (const b of details.matchingBroadcasts) {
      lines.push(`  - Notice ${b.id} (v${b.version}): expires ${b.expiresAt ?? 'until revoked'}`);
      lines.push(`    "${b.text}"`);
    }
    lines.push('');
  } else {
    lines.push('Local administrator notices: none matching this session.');
    lines.push('');
  }

  if (details.previewResult && details.previewResult.ok) {
    lines.push(formatPreview(details.previewResult, {
      // 'sent-to-cli' means evidence that a launch handed the rules to the CLI. This summary is read
      // before any launch, so it can only say prepared (not sent yet) or that the user must paste them.
      injection: {
        label: details.injectionStatusLabel ?? 'Prepared',
        state: details.injectionState === 'manual' || details.injectionState === 'unsupported' ? 'unsupported' : 'preview-only'
      },
      includeResearchSkills: true,
      workspaceRoot: snapshot.repoRoot
    } as any));
  } else if (details.effectiveRules && details.effectiveRules.instructions.length > 0) {
    lines.push('Effective instructions:');
    for (const rule of details.effectiveRules.instructions) {
      lines.push(`  - ${rule.text} [${rule.layer}; ${rule.id}]`);
    }
    lines.push('');
  } else {
    lines.push('Effective instructions: (none)');
    lines.push('');
  }

  lines.push('Tool permissions note: prompt text is not OS access control; OS tools/broker enforce permissions.');

  return lines.join('\n');
}
