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
}

export interface PreparedInstructions {
  ok: true;
  snapshot: InstructionSnapshot;
  plan: any | null;
  digest: string | null;
  method: string;
  argv: string[];
  injectionState: 'prepared' | 'launch-requested' | 'manual' | 'unsupported' | 'none';
  injectionStatusLabel: string;
  renderedContext: string | null;
  summaryText: string;
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
    const userLayer = [...(layers.user ?? []), ...broadcastRules];
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
  } else if (broadcastRules.length > 0) {
    for (const bRule of broadcastRules) {
      if (typeof bRule.text === 'string' && checkPromptInjection(bRule.text).hasInjection) {
        return {
          ok: false,
          code: 'prompt-injection-detected',
          message: 'Adversarial prompt injection detected in broadcast instruction.'
        };
      }
    }
    const resolved = resolveRules(broadcastRules);
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
      memories: []
    });

    try {
      const ruleInjection = builtIn.capability(provider, 'ruleInjection');
      const canInjectRules = ruleInjection === 'verified' || ruleInjection === 'unverified';

      plan = planInjection({
        provider,
        roleGroup: group ?? { id: 'unassigned', name: 'Agent', role: 'general' },
        rules: effectiveRules,
        memories: [],
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
    digest,
    createdAt: now.toISOString()
  };

  const summaryText = formatInstructionSummary(snapshot, {
    group,
    previewResult,
    effectiveRules,
    permissions,
    matchingBroadcasts,
    injectionStatusLabel,
    now
  });

  return {
    ok: true,
    snapshot,
    plan,
    digest,
    method,
    argv,
    injectionState,
    injectionStatusLabel,
    renderedContext,
    summaryText
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
    injectionStatusLabel?: string;
    now: Date;
  }
): string {
  const lines: string[] = [
    'PRIVATE — local agent instructions snapshot. Do not publish this document.',
    `Session ID: ${snapshot.targetSessionId}`,
    `Provider: ${snapshot.provider}`,
    `Role group: ${snapshot.roleGroupId}${snapshot.roleGroupVersion !== null ? ` (v${snapshot.roleGroupVersion})` : ' (none)'}`,
    `Account profile: ${snapshot.accountProfileId}`,
    `Requested model: ${snapshot.requestedModel ?? 'CLI default'}`,
    `Delivery: ${details.injectionStatusLabel ?? 'unknown'}`,
    `Digest: ${snapshot.digest ?? 'none'}`,
    `Prepared at: ${snapshot.createdAt}`,
    ''
  ];

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
      injection: { label: details.injectionStatusLabel ?? 'Prepared', state: 'sent-to-cli' },
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
