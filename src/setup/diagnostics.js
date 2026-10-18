'use strict';

const { builtIn, CAPABILITIES } = require('../providers/registry');
const { validateProfile, findConfigDirConflicts } = require('../accounts/profile');
const { groupBySubject } = require('../accounts/observation');
const { reportEntry, profileReadiness, fleetReadiness } = require('../accounts/readiness');
const { findSecrets } = require('../storage/sensitive');

const MIN_VSCODE_VERSION = '1.95.0';
const MIN_NODE_MAJOR = 20;

const SEMVER_PREFIX = /^v?(\d+)\.(\d+)\.(\d+)/;

function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = SEMVER_PREFIX.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    normalized: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function checkRuntimeVersions({ vscodeVersion, nodeVersion } = {}) {
  const minVscode = parseSemver(MIN_VSCODE_VERSION);
  const parsedVscode = parseSemver(vscodeVersion);
  const parsedNode = parseSemver(nodeVersion);

  const vscodeOk = parsedVscode !== null && compareSemver(parsedVscode, minVscode) >= 0;
  const nodeOk = parsedNode !== null && parsedNode.major >= MIN_NODE_MAJOR;

  return {
    vscodeVersion: parsedVscode ? parsedVscode.normalized : 'unknown',
    minVscodeVersion: MIN_VSCODE_VERSION,
    vscodeOk,
    nodeVersion: parsedNode ? parsedNode.normalized : 'unknown',
    minNodeMajor: MIN_NODE_MAJOR,
    nodeOk
  };
}

function classifyManagedTool(status) {
  if (!status || typeof status !== 'object') {
    return { state: 'unknown', category: 'first-use-pending', reason: 'not-checked', version: null };
  }
  if (status.state === 'ready') {
    return { state: 'ready', category: 'ready', reason: null, version: typeof status.version === 'string' ? status.version : null };
  }
  if (status.state === 'unsupported') {
    return { state: 'unsupported', category: 'platform-unsupported', reason: status.reason || 'unsupported-platform', version: null };
  }
  const reason = typeof status.reason === 'string' ? status.reason : 'unknown';
  if (reason === 'not-installed' || reason === 'not-activated') {
    return { state: 'missing', category: 'first-use-pending', reason, version: null };
  }
  if (reason === 'private-storage-unavailable') {
    return { state: 'missing', category: 'storage-blocked', reason, version: null };
  }
  if (/checksum|sha256|hash|download|extract|archive|size|corrupt|signature|manifest/i.test(reason)) {
    return { state: 'missing', category: 'download-or-integrity-failed', reason, version: null };
  }
  return { state: 'missing', category: 'tool-not-ready', reason, version: null };
}

function summarizeAccountReadiness({ profiles = [], observations = new Map(), repoRoot = null } = {}) {
  const safeProfiles = Array.isArray(profiles) ? profiles.filter((p) => p && typeof p === 'object') : [];
  const obsMap = observations instanceof Map ? observations : new Map();
  const context = repoRoot ? { repoRoot } : {};
  const profilesWithConfigDir = safeProfiles.filter((p) => typeof p.configDir === 'string' && p.configDir.trim() !== '');
  let conflicts = [];
  if (repoRoot && profilesWithConfigDir.length > 0) {
    try {
      conflicts = findConfigDirConflicts(profilesWithConfigDir, context);
    } catch {
      conflicts = [{ kind: 'unresolvable' }];
    }
  }
  const identities = safeProfiles.map((profile) => obsMap.get(profile.id)?.identity).filter(Boolean);
  const grouping = groupBySubject(identities);

  const entries = safeProfiles.map((profile) => {
    const obs = obsMap.get(profile.id) || {};
    let validation = obs.validation;
    if (!validation) {
      if (!repoRoot) {
        validation = { ok: false, problems: ['repo-root-missing'] };
      } else if (typeof profile.configDir !== 'string' || profile.configDir.trim() === '') {
        validation = { ok: false, problems: ['config-dir-missing'] };
      } else {
        try {
          validation = validateProfile(profile, context);
        } catch {
          validation = { ok: false, problems: ['invalid-profile'] };
        }
      }
    }
    return reportEntry(profile.id, {
      validation,
      blockers: obs.blockers || [],
      identity: obs.identity || null
    });
  });

  const fleet = fleetReadiness(entries, { conflicts, duplicates: grouping.duplicates });
  const reasonCounts = {};
  const byProvider = {};
  let readyCount = 0;
  let unreadyCount = 0;

  for (let index = 0; index < safeProfiles.length; index += 1) {
    const profile = safeProfiles[index];
    const provider = typeof profile?.provider === 'string' ? profile.provider : 'unknown';
    if (!byProvider[provider]) byProvider[provider] = { total: 0, ready: 0, unready: 0 };
    byProvider[provider].total += 1;

    const readiness = profileReadiness(entries[index]);
    if (readiness.ready) {
      readyCount += 1;
      byProvider[provider].ready += 1;
    } else {
      unreadyCount += 1;
      byProvider[provider].unready += 1;
      for (const reason of readiness.reasons) {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
    }
  }

  for (const reason of fleet.reasons) {
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  return {
    totalProfiles: safeProfiles.length,
    readyCount,
    unreadyCount,
    fleetReady: safeProfiles.length > 0 && fleet.ready,
    byProvider,
    reasonCounts
  };
}

function diagnose({
  vscodeVersion,
  nodeVersion = process.versions?.node,
  storageStatus = null,
  storeStatus = null,
  lockStatus = null,
  maskedExport = null,
  profiles = [],
  observations = new Map(),
  repoRoot = null,
  executables = {},
  managedTools = {},
  now = () => Date.now()
} = {}) {
  const runtime = checkRuntimeVersions({ vscodeVersion, nodeVersion });
  const ghTool = classifyManagedTool(managedTools.gh);
  const codexTool = classifyManagedTool(managedTools.codex);
  const claudeTool = classifyManagedTool(managedTools.claude);
  const agyTool = classifyManagedTool(managedTools.agy || { state: 'unsupported', reason: 'unverified-source-and-terms' });

  const providers = builtIn.list().map((provider) => {
    const onPath = Boolean(executables[provider.id]);
    const managedReady = provider.id === 'codex'
      ? codexTool.state === 'ready'
      : provider.id === 'claude'
        ? claudeTool.state === 'ready'
        : false;
    const capabilities = {};
    for (const cap of CAPABILITIES) {
      capabilities[cap] = provider.capabilities[cap] || 'unknown';
    }
    return {
      id: provider.id,
      support: provider.support,
      executableOnPath: onPath,
      managedReady,
      cliAvailable: onPath || managedReady,
      capabilities
    };
  });

  const accounts = summarizeAccountReadiness({
    profiles,
    observations,
    repoRoot,
    executables,
    managedTools
  });

  const storage = {
    state: storageStatus?.state ?? 'unknown',
    reason: storageStatus?.reason ?? null,
    problems: Array.isArray(storageStatus?.problems) ? [...storageStatus.problems] : [],
    vaultProbe: storageStatus?.secrets ?? 'not-checked',
    coverage: storageStatus?.coverage
      ? {
          level: storageStatus.coverage.level,
          folders: Number(storageStatus.coverage.folders) || 0,
          repositoriesFound: Number(storageStatus.coverage.repositoriesFound) || 0
        }
      : null,
    store: storeStatus
      ? {
          ok: Boolean(storeStatus.ok),
          reason: storeStatus.reason ?? null,
          detail: storeStatus.detail ?? null,
          schemaVersion: storeStatus.schemaVersion ?? null,
          onDiskVersion: storeStatus.onDiskVersion ?? null,
          pendingMigration: Boolean(storeStatus.pendingMigration),
          looseFileMode: Boolean(storeStatus.looseFileMode)
        }
      : null,
    lock: lockStatus
      ? {
          ok: Boolean(lockStatus.ok),
          held: Boolean(lockStatus.held),
          stale: Boolean(lockStatus.stale)
        }
      : null
  };

  const actions = [];

  if (!runtime.nodeOk) {
    actions.push({
      code: 'node-version-unsupported',
      severity: 'error',
      summary: `Node.js runtime (${runtime.nodeVersion}) does not meet the minimum major version (${runtime.minNodeMajor}).`,
      nextAction: `Run VS Code with Node.js >= ${runtime.minNodeMajor}.`,
      command: null
    });
  }
  if (!runtime.vscodeOk) {
    actions.push({
      code: 'vscode-version-unsupported',
      severity: 'error',
      summary: `VS Code (${runtime.vscodeVersion}) does not meet the minimum version (${runtime.minVscodeVersion}).`,
      nextAction: `Update VS Code to ${runtime.minVscodeVersion} or newer.`,
      command: null
    });
  }

  if (storage.state !== 'available') {
    actions.push({
      code: `storage-unavailable:${storage.reason || 'unknown'}`,
      severity: 'error',
      summary: `Private storage is unavailable (${storage.problems.join(', ') || storage.reason || 'unknown'}). Nothing is stored in the workspace.`,
      nextAction: 'Ensure the extension globalStorage folder is outside any open Git repository, then re-check storage status.',
      command: 'multiagentSystem.storage.status'
    });
  } else if (storage.store && !storage.store.ok) {
    actions.push({
      code: `store-unusable:${storage.store.reason || 'unknown'}`,
      severity: 'error',
      summary: `Private store cannot be loaded (${storage.store.reason || 'unknown'}).`,
      nextAction: 'Clear corrupt or unsupported store files owned by this extension to recover a clean store.',
      command: 'multiagentSystem.setup.clearStorage'
    });
  } else if (storage.store?.pendingMigration) {
    actions.push({
      code: 'storage-migration-pending',
      severity: 'warning',
      summary: `Private store on disk (v${storage.store.onDiskVersion ?? 'unknown'}) has a pending schema migration to v${storage.store.schemaVersion ?? 'unknown'}.`,
      nextAction: 'Run Migrate Private Storage Schema to back up and upgrade on-disk records.',
      command: 'multiagentSystem.setup.migrateStorage'
    });
  }

  if (storage.lock?.held) {
    actions.push({
      code: storage.lock.stale ? 'storage-lock-stale' : 'storage-lock-held',
      severity: storage.lock.stale ? 'warning' : 'info',
      summary: storage.lock.stale
        ? 'Single-writer storage lock is held past the stale threshold.'
        : 'Single-writer storage lock is currently held.',
      nextAction: storage.lock.stale
        ? 'Recover the stale storage lock if no other window is writing.'
        : 'Wait for the current write to complete or inspect the lock.',
      command: 'multiagentSystem.setup.recoverStorageLock'
    });
  }

  if (!executables.git) {
    actions.push({
      code: 'tool-git-missing',
      severity: 'error',
      summary: 'Git executable was not found on PATH (required for isolated worktrees).',
      nextAction: 'Install Git on PATH and refresh Tools Setup.',
      command: 'multiagentSystem.setup.refresh'
    });
  }

  if (ghTool.state !== 'ready' && !executables.gh) {
    const summaryByCategory = {
      'first-use-pending': 'Managed GitHub CLI (gh) has not been prepared yet, and gh is not on PATH.',
      'download-or-integrity-failed': `Managed GitHub CLI (gh) setup failed download or SHA-256 verification (${ghTool.reason}).`,
      'platform-unsupported': `Managed GitHub CLI (gh) is not supported on this platform (${ghTool.reason}).`,
      'storage-blocked': 'Managed GitHub CLI (gh) cannot be prepared while private storage is unavailable.',
      'tool-not-ready': `Managed GitHub CLI (gh) is not ready (${ghTool.reason}).`
    };
    actions.push({
      code: `tool-gh-${ghTool.category}`,
      severity: ghTool.category === 'download-or-integrity-failed' ? 'error' : 'warning',
      summary: summaryByCategory[ghTool.category] || summaryByCategory['tool-not-ready'],
      nextAction: 'Run Retry Verified GitHub CLI Setup in Tools Setup.',
      command: 'multiagentSystem.setup.retryGh'
    });
  }

  if (codexTool.category === 'download-or-integrity-failed') {
    actions.push({
      code: 'tool-codex-download-or-integrity-failed',
      severity: 'error',
      summary: `Managed Codex CLI setup failed download or SHA-256 verification (${codexTool.reason}).`,
      nextAction: 'Run Retry Verified Codex CLI Setup in Tools Setup.',
      command: 'multiagentSystem.setup.retryCodex'
    });
  }

  if (claudeTool.category === 'download-or-integrity-failed') {
    actions.push({
      code: 'tool-claude-download-or-integrity-failed',
      severity: 'error',
      summary: `Managed Claude Code CLI setup failed download or SHA-256 verification (${claudeTool.reason}).`,
      nextAction: 'Run Retry Verified Claude Code CLI Setup in Tools Setup.',
      command: 'multiagentSystem.setup.retryClaude'
    });
  }

  for (const provider of providers) {
    if (!provider.cliAvailable) {
      actions.push({
        code: `provider-cli-missing:${provider.id}`,
        severity: 'warning',
        summary: `Provider CLI '${provider.id}' is not installed on PATH${provider.id === 'codex' || provider.id === 'claude' ? ' or in managed tools' : ''}.`,
        nextAction: provider.id === 'codex'
          ? 'Run Retry Verified Codex CLI Setup or install codex on PATH.'
          : provider.id === 'claude'
            ? 'Run Retry Verified Claude Code CLI Setup or install claude on PATH.'
            : provider.id === 'agy'
              ? 'Install official \'agy\' CLI on PATH manually (managed auto-deployment is unverified and unsupported).'
              : `Install '${provider.id}' on PATH before launching '${provider.id}' sessions.`,
        command: provider.id === 'codex'
          ? 'multiagentSystem.setup.retryCodex'
          : provider.id === 'claude'
            ? 'multiagentSystem.setup.retryClaude'
            : 'multiagentSystem.setup.refresh'
      });
    }
  }

  if (accounts.totalProfiles === 0) {
    actions.push({
      code: 'accounts-none-configured',
      severity: 'warning',
      summary: 'No account profiles are configured yet.',
      nextAction: 'Create an account profile for Claude Code or Codex CLI.',
      command: 'multiagentSystem.accounts.create'
    });
  } else {
    if (accounts.reasonCounts['not-logged-in'] > 0) {
      actions.push({
        code: 'accounts-not-logged-in',
        severity: 'warning',
        summary: `${accounts.reasonCounts['not-logged-in']} account profile(s) have CLI installed/inspected but are not signed in.`,
        nextAction: 'Sign in to the account profile in a native terminal, then re-check sign-in.',
        command: 'multiagentSystem.accounts.login'
      });
    }
    if (accounts.reasonCounts['not-inspected'] > 0 || accounts.reasonCounts['subject-unverified'] > 0 || accounts.reasonCounts['config-dir-unverified'] > 0) {
      const count = (accounts.reasonCounts['not-inspected'] || 0) + (accounts.reasonCounts['subject-unverified'] || 0);
      actions.push({
        code: 'accounts-identity-unverified',
        severity: 'warning',
        summary: `${count} account profile(s) have unverified or uninspected service identity (kept as unknown until verified).`,
        nextAction: 'Run Check Account Sign-in to verify account identity and configuration folder isolation.',
        command: 'multiagentSystem.accounts.check'
      });
    }
    if (accounts.reasonCounts['duplicate-account'] > 0) {
      actions.push({
        code: 'accounts-duplicate-subject',
        severity: 'warning',
        summary: 'Multiple account profiles resolve to the same service identity.',
        nextAction: 'Remove or update duplicate account profiles so quota is not double-counted.',
        command: 'multiagentSystem.accounts.refresh'
      });
    }
  }

  if (actions.length === 0) {
    actions.push({
      code: 'diagnostics-all-clear',
      severity: 'ok',
      summary: 'Runtime, private storage, tools, and configured accounts passed diagnostic checks.',
      nextAction: 'None.',
      command: null
    });
  }

  const safeMaskedExport = maskedExport && maskedExport.ok && maskedExport.export ? maskedExport.export : null;
  const hasError = actions.some((item) => item.severity === 'error');
  const hasWarning = actions.some((item) => item.severity === 'warning');

  const report = {
    generatedAt: new Date(now()).toISOString(),
    overall: hasError ? 'error' : hasWarning ? 'attention' : 'ok',
    runtime,
    storage,
    tools: {
      gitOnPath: Boolean(executables.git),
      ghOnPath: Boolean(executables.gh),
      managedGh: ghTool,
      managedCodex: codexTool,
      managedClaude: claudeTool,
      managedAgy: agyTool
    },
    providers,
    accounts,
    actions,
    maskedExport: safeMaskedExport
  };

  // Defense-in-depth: verify no secret patterns exist anywhere in the diagnostic report.
  const secretHits = findSecrets(report);
  if (secretHits.length > 0) {
    throw new Error('diagnostic-report-secret-detected');
  }

  return report;
}

function formatDiagnosticReport(report) {
  const lines = [
    '# Multiagent Masked Setup & Storage Diagnostics',
    '',
    `Generated: ${report.generatedAt}`,
    `Overall status: ${report.overall.toUpperCase()}`,
    'Privacy note: Local file paths, account labels, credentials, prompts, and memory text are omitted or masked. Safe to copy into GitHub Issues.',
    '',
    '## 1. Runtime Versions',
    `- VS Code: ${report.runtime.vscodeVersion} (min ${report.runtime.minVscodeVersion}) -> ${report.runtime.vscodeOk ? 'OK' : 'UNSUPPORTED'}`,
    `- Node.js: ${report.runtime.nodeVersion} (min major ${report.runtime.minNodeMajor}) -> ${report.runtime.nodeOk ? 'OK' : 'UNSUPPORTED'}`,
    '',
    '## 2. Private Storage & Lock Status',
    `- Availability: ${report.storage.state}${report.storage.reason ? ` (${report.storage.reason})` : ''}`,
    `- Problems: ${report.storage.problems.length > 0 ? report.storage.problems.join(', ') : 'none'}`,
    `- SecretStorage probe: ${report.storage.vaultProbe}`,
    `- Store state: ${report.storage.store ? (report.storage.store.ok ? 'ok' : `${report.storage.store.reason || 'error'}`) : 'unavailable'}`,
    `- Schema version: ${report.storage.store?.schemaVersion ?? 'unknown'} (on-disk: ${report.storage.store?.onDiskVersion ?? 'none'}, pendingMigration: ${Boolean(report.storage.store?.pendingMigration)})`,
    `- Single-writer lock: ${report.storage.lock ? (report.storage.lock.held ? (report.storage.lock.stale ? 'held (stale)' : 'held (active)') : 'free') : 'unknown'}`,
    '',
    '## 3. Managed Tools & Provider Discovery',
    `- git on PATH: ${report.tools.gitOnPath ? 'yes' : 'no'}`,
    `- gh: managed=${report.tools.managedGh.state} (${report.tools.managedGh.category}${report.tools.managedGh.reason ? `:${report.tools.managedGh.reason}` : ''}), onPath=${report.tools.ghOnPath ? 'yes' : 'no'}`,
    `- codex (managed): ${report.tools.managedCodex.state} (${report.tools.managedCodex.category}${report.tools.managedCodex.reason ? `:${report.tools.managedCodex.reason}` : ''})`,
    `- claude (managed): ${report.tools.managedClaude.state} (${report.tools.managedClaude.category}${report.tools.managedClaude.reason ? `:${report.tools.managedClaude.reason}` : ''})`,
    `- agy (managed): ${report.tools.managedAgy.state} (${report.tools.managedAgy.category}${report.tools.managedAgy.reason ? `:${report.tools.managedAgy.reason}` : ''})`,
    ''
  ];

  for (const provider of report.providers) {
    const caps = Object.entries(provider.capabilities)
      .map(([name, status]) => `${name}=${status}`)
      .join(', ');
    lines.push(`- Provider \`${provider.id}\` (${provider.support}): onPath=${provider.executableOnPath ? 'yes' : 'no'}, managedReady=${provider.managedReady ? 'yes' : 'no'} | capabilities: ${caps}`);
  }

  lines.push(
    '',
    '## 4. Account Fleet Readiness (Redacted Counts Only)',
    `- Total profiles: ${report.accounts.totalProfiles} (ready: ${report.accounts.readyCount}, unready: ${report.accounts.unreadyCount}, fleetReady: ${report.accounts.fleetReady})`,
    `- Reason counts: ${Object.keys(report.accounts.reasonCounts).length > 0 ? JSON.stringify(report.accounts.reasonCounts) : 'none'}`,
    '',
    '## 5. Actionable Next Steps'
  );

  for (const action of report.actions) {
    const cmd = action.command ? ` [Command: \`${action.command}\`]` : '';
    lines.push(`- [${action.severity.toUpperCase()}] \`${action.code}\`: ${action.summary} Next: ${action.nextAction}${cmd}`);
  }

  lines.push(
    '',
    '## 6. Masked Private Store Structure (`exportMasked`)',
    '```json',
    JSON.stringify(report.maskedExport, null, 2),
    '```',
    ''
  );

  return lines.join('\n');
}

module.exports = {
  MIN_VSCODE_VERSION,
  MIN_NODE_MAJOR,
  parseSemver,
  checkRuntimeVersions,
  classifyManagedTool,
  summarizeAccountReadiness,
  diagnose,
  formatDiagnosticReport
};
