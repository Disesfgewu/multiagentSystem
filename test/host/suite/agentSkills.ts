import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function runAgentSkillChecks(workspace: string): Promise<void> {
  const names = ['code-review-on-git', 'fetch-comments', 'fetch-issues', 'fetch-prs', 'raise-issue', 'raise-pr', 'resolve-conflicts', 'resolve-issues'];
  const files = ['.claude', '.agents'].flatMap((root) => names.map((name) => path.join(workspace, root, 'skills', name, 'SKILL.md')));
  const deadline = Date.now() + 5000;
  while (!files.every((file) => fs.existsSync(file)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /^---\r?\nname:/);
  assert.equal(fs.existsSync(path.join(workspace, '.github/ISSUE_TEMPLATE/standard.md')), false, 'automatic preparation never adds GitHub templates');
  const edited = path.join(workspace, '.agents/skills/fetch-prs/SKILL.md');
  fs.writeFileSync(edited, 'synthetic user edit');
  const removed = await vscode.commands.executeCommand<any>('multiagentSystem.skills.remove', { interactive: false });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(fs.readFileSync(edited, 'utf8'), 'synthetic user edit');
  assert.equal(fs.existsSync(files[0]), false);
  // A configuration refresh invokes automatic setup again, but removal stays respected.
  const config = vscode.workspace.getConfiguration('multiagentSystem');
  await config.update('skills.autoInstall', false, vscode.ConfigurationTarget.Global);
  await config.update('skills.autoInstall', true, vscode.ConfigurationTarget.Global);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(files[0]), false);
  const installed = await vscode.commands.executeCommand<any>('multiagentSystem.skills.install', { interactive: false });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.written.length, 15, 'explicit install restores both hosts while preserving edits');
  assert.equal(fs.readFileSync(edited, 'utf8'), 'synthetic user edit');
  console.log('host smoke: activation prepares bundled skills in both official discovery locations; removal persists and explicit reinstall preserves edits; actual CLI loading unverified');
}
