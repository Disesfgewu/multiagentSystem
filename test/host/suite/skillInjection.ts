import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../../../src/storage/storageCommands';
import { saveRoleRecord } from '../../../src/roles/roleCommands';
const { SkillLibrary } = require('../../../src/skills/library') as { SkillLibrary: new (store: unknown) => any };

type Listed = { sessions: Array<{ id: string; injectedCounts?: { rules: number; memories: number; skills?: number } | null; injectedSizes?: { skills: { chars: number }; total: { tokens: number } } | null }> };

/**
 * #359 in a real Extension Host: an agent of a role group is given the list of that role group's skills, not their text; each skill
 * is written as its own file in that session's private folder (never into the repository), and the session says how much it was
 * given. A skill that is off, or for another role group, is not given.
 */
export async function runSkillInjectionChecks(workspace: string): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const store = opened.store as any;
  const ROLE = 'host-skill-inject-359';
  const saved = await saveRoleRecord({
    group: {
      id: ROLE, name: 'Host Skill Injection', role: 'worker', provider: 'claude', version: 1,
      defaultAccountProfileId: null, allowedScope: { repositories: [], paths: [] },
      toolPermissions: {}, memoryScope: { mode: 'off' }, rules: [{ id: 'host-skill-rule', type: 'instruction', text: 'Keep changes small.', version: 1 }]
    },
    layers: {}
  } as Parameters<typeof saveRoleRecord>[0]);
  assert.equal(saved.ok, true, saved.reason);
  const library = new SkillLibrary(store);
  const names = ['host-given-359', 'host-off-359', 'host-other-359'];
  assert.equal(library.save({ name: names[0], description: 'Use it in this host test.', body: 'THE-STEPS-OF-THE-GIVEN-SKILL', roles: [ROLE] }, 0).ok, true);
  assert.equal(library.save({ name: names[1], description: 'Turned off.', body: 'x', roles: [ROLE], state: 'disabled' }, 0).ok, true);
  assert.equal(library.save({ name: names[2], description: 'Another role group.', body: 'y', roles: ['someone-else'] }, 0).ok, true);
  let id: string | undefined;
  try {
    const started = await vscode.commands.executeCommand<{ ok: boolean; message?: string; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Host Skill Agent', cwd: workspace, roleGroupId: ROLE });
    assert.equal(started?.ok, true, JSON.stringify(started));
    id = started!.session!.id;
    const session = (await vscode.commands.executeCommand<Listed>('multiagentSystem.sessions.list', { interactive: false })).sessions.find((entry) => entry.id === id);
    assert.equal(session?.injectedCounts?.skills, 1, 'one skill is on and for this role group');
    assert.ok(session?.injectedSizes && session.injectedSizes.skills.chars > 0 && session.injectedSizes.total.tokens > 0, JSON.stringify(session?.injectedSizes));
    const folder = path.join(store.dir, 'sessions', id, 'skills');
    assert.deepEqual(fs.readdirSync(folder).sort(), ['_answers', names[0]], 'only the given skill is written, in the session\'s own folder (with the folder its Ask answers go to, #357)');
    assert.match(fs.readFileSync(path.join(folder, names[0], 'SKILL.md'), 'utf8'), /THE-STEPS-OF-THE-GIVEN-SKILL/);
    const context = fs.readFileSync(path.join(store.dir, 'sessions', id, 'claude-context.md'), 'utf8');
    assert.ok(context.includes(`- ${names[0]}: Use it in this host test. (file: ${path.join(folder, names[0], 'SKILL.md')})`), context);
    assert.equal(context.includes('THE-STEPS-OF-THE-GIVEN-SKILL'), false, 'the instructions list the skill; they do not carry its text');
    for (const name of names) assert.equal(fs.existsSync(path.join(workspace, '.claude', 'skills', name)), false, 'nothing is written into the repository');
  } finally {
    if (id) { try { await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id, interactive: false }); } catch { /* already stopped */ } }
    store.transact((tx: any) => { tx.delete('roleGroups', ROLE); for (const name of names) tx.delete('skills', name); return true; });
  }
  console.log('host smoke: an agent is given the list of its role group\'s skills, with each file in its own session folder and nothing in the repository');
}
