import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';

const { checkRoleForLaunch, roleChoices } = require('./launch-role') as {
  checkRoleForLaunch(input: { id: unknown; provider: string; record: unknown }): { ok: true; group: { id: string; name: string; provider: string; version: number } } | { ok: false; code: string; message: string };
  roleChoices(items: unknown, provider: string): { choices: Array<{ id: string; name: string; role: string; version: number; defaultAccountProfileId: string | null }>; skipped: number };
};

type Store = { list(collection: string): any; get(collection: string, id: string): any };

async function openStore(): Promise<Store | undefined> {
  const opened = await privateStorage()?.use();
  return opened?.ok ? (opened.store as Store) : undefined;
}

/** Reads the stored role group and checks it may be assigned to a new session of this provider. */
export async function resolveRoleForLaunch(id: string, provider: string): Promise<{ ok: true; group: { id: string; name: string; version: number } } | { ok: false; code: string; message: string }> {
  const store = await openStore();
  if (!store) return { ok: false, code: 'role-group-unreadable', message: 'Private role group storage is not available, so the role group cannot be checked.' };
  const loaded = store.get('roleGroups', id);
  if (!loaded.ok) return { ok: false, code: 'role-group-unreadable', message: 'The role group could not be read from private storage.' };
  return checkRoleForLaunch({ id, provider, record: loaded.found ? loaded.value : null });
}

/**
 * Lets the person choose a role group for a new session. Returns `undefined` when they cancel, the
 * string `none` for "no role group", or a group id. Role groups for other CLIs are not offered.
 */
export async function pickRoleForLaunch(provider: string): Promise<string | undefined> {
  const store = await openStore();
  if (!store) {
    throw Object.assign(new Error('Role groups could not be read.'), { code: 'role-group-unreadable' });
  }
  const listed = store.list('roleGroups');
  if (!listed.ok || !Array.isArray(listed.items)) {
    throw Object.assign(new Error('Role groups could not be read.'), { code: 'role-group-unreadable' });
  }
  const { choices, skipped } = roleChoices(listed.items, provider);
  if (skipped > 0) throw Object.assign(new Error('Role groups could not be validated.'), { code: 'role-group-unreadable' });
  if (choices.length === 0 && skipped === 0) return 'none';
  const picked = await vscode.window.showQuickPick([
    { label: 'No role group', detail: 'The agent starts without any role rules from this extension.', id: 'none' },
    ...choices.map((choice) => ({ label: choice.name, description: choice.role, detail: 'Assigned to this new agent. Rules are not yet sent to the CLI; the preview shows their status.', id: choice.id }))
  ], { placeHolder: 'Choose a role group for this agent', ignoreFocusOut: true });
  return picked?.id;
}
