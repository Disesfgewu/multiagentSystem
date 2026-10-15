const { AccountProfileService } = require('./profile-service') as {
  AccountProfileService: new (options: { store: unknown; vault: unknown; sessions: () => unknown[] }) => {
    list(): any;
    get(id: string): any;
    create(fields: Record<string, unknown>): any;
    update(id: string, fields: Record<string, unknown>, options?: Record<string, unknown>): any;
    remove(id: string, options?: Record<string, unknown>): Promise<any>;
    resolveForLaunch(id: string): any;
  };
};
const fs = require('node:fs') as typeof import('node:fs');
const { validateProfile } = require('./profile') as { validateProfile(profile: unknown, context: { repoRoot: string }): { ok: boolean; problems: string[] } };
const { PROVIDERS, buildLaunchEnv } = require('./profile') as {
  PROVIDERS: Record<string, { configEnvVar: string; credentialOverrideVars: readonly string[] }>;
  buildLaunchEnv(profile: unknown, baseEnv: NodeJS.ProcessEnv, context: { repoRoot: string }): {
    env: Record<string, string>;
    blockers: Array<{ code: string; variable?: string }>;
  };
};
const { canonicalize, pathFor } = require('../shared/paths') as {
  canonicalize(target: string, pathModule: typeof import('node:path'), realpath: (value: string) => string, isDirectory: (value: string) => boolean, lstat: (value: string) => import('node:fs').Stats): string;
  pathFor(platform: string): typeof import('node:path');
};

export type SessionUse = { accountProfileId: string; terminalOpen: boolean; provider?: string };

export function terminalAccountEnvironment(
  provider: string,
  baseEnv: NodeJS.ProcessEnv,
  repoRoot: string,
  profile: Record<string, unknown>
): { ok: true; env: Record<string, string | null> } | { ok: false; code: string; message: string } {
  const spec = PROVIDERS[provider];
  if (!spec) return { ok: false, code: 'provider-unsupported', message: 'This provider has no account configuration support.' };
  const validation = validateProfile(profile, { repoRoot });
  if (!validation.ok) {
    return { ok: false, code: 'account-config-rejected', message: 'This account configuration folder no longer passes the safety checks. Refresh the account profile and try again.' };
  }
  let configDir: string;
  try {
    configDir = canonicalize(String(profile.configDir), pathFor(process.platform),
      (value) => fs.realpathSync.native(value),
      (value) => fs.statSync(value).isDirectory(),
      (value) => fs.lstatSync(value));
  } catch {
    return { ok: false, code: 'account-config-rejected', message: 'This account configuration folder no longer passes the safety checks. Refresh the account profile and try again.' };
  }
  const prepared = buildLaunchEnv({ ...profile, configDir }, baseEnv, { repoRoot });
  if (prepared.blockers.some((blocker) => blocker.code === 'config-dir-rejected')) {
    return { ok: false, code: 'account-config-rejected', message: 'This account configuration folder no longer passes the safety checks. Refresh the account profile and try again.' };
  }
  if (prepared.blockers.length > 0) {
    return { ok: false, code: 'credential-override', message: 'An inherited credential or provider setting would override this account. Remove it from the environment before launching.' };
  }
  const env: Record<string, string | null> = {};
  for (const name of spec.credentialOverrideVars) {
    const existing = Object.keys(baseEnv).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing) env[existing] = null;
  }
  env[spec.configEnvVar] = prepared.env[spec.configEnvVar];
  return { ok: true, env };
}

export async function accountService(sessions: () => SessionUse[]) {
  const { privateStorage } = require('../storage/storageCommands') as { privateStorage(): { use(): Promise<any> } | undefined };
  const handle = privateStorage();
  if (!handle) return { ok: false as const, code: 'storage-unavailable', message: 'Private account storage is not ready.' };
  const storage = await handle.use();
  if (!storage.ok) return { ok: false as const, code: 'storage-unavailable', message: 'Private account storage is unavailable. Check the storage status command.' };
  const service = new AccountProfileService({ store: storage.store, vault: storage.vault, sessions });
  return { ok: true as const, service, store: storage.store };
}

export async function launchEnvironment(
  id: string,
  provider: string,
  sessions: () => SessionUse[]
): Promise<{ ok: true; profile: Record<string, any>; env: Record<string, string | null>; isolation: string } | { ok: false; code: string; message: string }> {
  const loaded = await accountService(sessions);
  if (!loaded.ok) return loaded;
  const resolved = loaded.service.resolveForLaunch(id);
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  const profile = resolved.profile as Record<string, any>;
  if (profile.provider !== provider) return { ok: false, code: 'provider-mismatch', message: 'Choose an account profile for this CLI provider.' };
  const configured = terminalAccountEnvironment(provider, process.env, (loaded.store as { repoRoot: string }).repoRoot, profile);
  if (!configured.ok) return configured;
  const env = configured.env;
  return { ok: true, profile, env, isolation: 'unverified' };
}
