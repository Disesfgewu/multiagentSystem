import * as fs from 'node:fs';

const guidance = require('./folder-guidance') as {
  suggestFolder(input: { homeDir: string; provider: string; label: string }): { parent: string; dir: string; name: string };
  checkFolder(input: { provider: string; label: string; configDir: string; profiles: unknown[]; context: { repoRoot: string; homeDir?: string } }): { ok: boolean; items: Explained[] };
  createRecommendedFolder(input: { provider: string; label: string; suggestion: { parent: string; dir: string; name: string }; profiles: unknown[]; context: { repoRoot: string; homeDir?: string } }): { ok: boolean; dir?: string; madeFolders?: FolderIdentity[]; items?: Explained[] };
  discardCreated(folders: FolderIdentity[]): string[];
};

export type FolderIdentity = { path: string; dev: string; ino: string };
export type Explained = { code: string; known: boolean; message: string; fix: string };

/** The three questions the chooser asks. The VS Code wiring answers them with real dialogs; tests answer them directly. */
export interface ChooserUi {
  pickAction(suggestionName: string): Promise<'create' | 'choose' | undefined>;
  openFolder(defaultPath: string): Promise<string | undefined>;
  showProblems(summary: string, detail: string, offerRecommended: boolean): Promise<'recommended' | 'another' | undefined>;
}

export type ChosenFolder = { ok: true; dir: string; created: boolean; madeFolders: FolderIdentity[] } | { ok: false };

export function describeProblems(items: Explained[]): string {
  return items.map((item) => `• ${item.message}\n  ${item.fix}`).join('\n\n');
}

/**
 * Lets the person pick where an account keeps its sign-in data. A recommended new folder is offered
 * first, a folder they choose is checked as soon as it is chosen, and a refusal is explained in
 * plain words with a way forward. Nothing in any message names a path.
 */
export async function chooseConfigFolder(options: {
  provider: string;
  label: string;
  profiles: unknown[];
  repoRoot: string;
  homeDir: string;
  ui: ChooserUi;
  exists?: (target: string) => boolean;
}): Promise<ChosenFolder> {
  const { provider, label, profiles, repoRoot, homeDir, ui } = options;
  const exists = options.exists ?? ((target: string) => fs.existsSync(target));
  const context = { repoRoot, homeDir };

  const createRecommended = async (): Promise<ChosenFolder | undefined> => {
    // The suggestion is made again each time so a folder made a moment ago is not offered twice.
    const suggestion = guidance.suggestFolder({ homeDir, provider, label });
    const made = guidance.createRecommendedFolder({ provider, label, suggestion, profiles, context });
    if (made.ok && made.dir) return { ok: true, dir: made.dir, created: true, madeFolders: made.madeFolders ?? [] };
    const items = made.items ?? [];
    const answer = await ui.showProblems('The recommended folder could not be created.', describeProblems(items), false);
    return answer === undefined ? { ok: false } : undefined;
  };

  for (let round = 0; round < 20; round += 1) {
    const suggestion = guidance.suggestFolder({ homeDir, provider, label });
    const action = await ui.pickAction(suggestion.name);
    if (action === undefined) return { ok: false };
    if (action === 'create') {
      const result = await createRecommended();
      if (result) return result;
      continue;
    }
    const start = exists(suggestion.parent) ? suggestion.parent : homeDir;
    const picked = await ui.openFolder(start);
    if (picked === undefined) continue;
    const checked = guidance.checkFolder({ provider, label, configDir: picked, profiles, context });
    if (checked.ok) return { ok: true, dir: picked, created: false, madeFolders: [] };
    const answer = await ui.showProblems('That folder cannot be used for this account.', describeProblems(checked.items), true);
    if (answer === undefined) return { ok: false };
    if (answer === 'recommended') {
      const result = await createRecommended();
      if (result) return result;
    }
  }
  return { ok: false };
}

/**
 * Call after the account was (or was not) saved. If the save failed, the folders this chooser made for it
 * are removed again (only while empty), so a refused save does not leave folders piling up.
 */
export function settleChosenFolder(chosen: ChosenFolder, saved: { ok: boolean }): string[] {
  if (!chosen.ok || saved.ok || chosen.madeFolders.length === 0) return [];
  return guidance.discardCreated(chosen.madeFolders);
}
