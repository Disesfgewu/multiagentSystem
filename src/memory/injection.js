'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const { LAYERS } = require('./rules');
const { checkPrivateRoot } = require('./paths');

const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function renderContext({ roleGroup, rules, memories }) {
  const lines = [`# Role: ${roleGroup.name}`];
  const ruleLines = [...rules.instructions]
    .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || a.id.localeCompare(b.id))
    .map((rule) => `- ${rule.text}`);
  if (rules.forbids.length > 0) {
    ruleLines.push(`- Do not: ${rules.forbids.map((rule) => rule.key).sort().join(', ')}`);
  }
  if (rules.requires.length > 0) {
    ruleLines.push(`- Always: ${rules.requires.map((rule) => rule.key).sort().join(', ')}`);
  }
  if (ruleLines.length > 0) lines.push('', '## Rules', ...ruleLines);

  // Stable ordering keeps the injected prefix identical between launches so the
  // provider's prompt cache can be reused.
  const memoryLines = [...memories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => `- ${item.content} (source: ${item.source.ref}; verified: ${item.verifiedAt.slice(0, 10)})`);
  if (memoryLines.length > 0) lines.push('', '## Project notes (reviewed, role-scoped)', ...memoryLines);
  return `${lines.join('\n')}\n`;
}

function tomlString(text) {
  return JSON.stringify(text).replace(/\u007f/g, '\\u007f');
}

// Builds a launch plan. The context text only ever goes into files under a
// private directory; argv carries a file path or a profile name, never content.
function planInjection(options) {
  const { provider, roleGroup, rules, memories, privateDir, repoRoot, sessionToken,
    codexHome, capabilities = {}, context } = options;
  if (!TOKEN.test(sessionToken || '')) throw new Error('invalid session token');

  const privateCheck = checkPrivateRoot(privateDir, repoRoot, context);
  if (!privateCheck.ok) throw new Error(`private directory rejected: ${privateCheck.problems.join(', ')}`);

  const text = renderContext({ roleGroup, rules, memories });
  const sessionDir = nodePath.join(privateDir, 'sessions', sessionToken);
  const manual = () => ({
    provider,
    method: 'manual',
    files: [{ path: nodePath.join(sessionDir, 'context.md'), content: text }],
    argv: [],
    cleanup: [sessionDir],
    note: 'Open the file and paste it into the terminal as the first message.'
  });

  if (provider === 'claude') {
    if (!capabilities.appendSystemPromptFile) return manual();
    const file = nodePath.join(sessionDir, 'claude-context.md');
    return {
      provider,
      method: 'append-system-prompt-file',
      files: [{ path: file, content: text }],
      argv: ['--append-system-prompt-file', file],
      cleanup: [sessionDir]
    };
  }

  if (provider === 'codex') {
    const profileName = `mas-${sessionToken}`;
    if (!capabilities.profileFlag || !codexHome || !PROFILE_NAME.test(profileName)) return manual();
    const homeCheck = checkPrivateRoot(codexHome, repoRoot, context);
    if (!homeCheck.ok) throw new Error(`CODEX_HOME rejected: ${homeCheck.problems.join(', ')}`);
    const file = nodePath.join(codexHome, `${profileName}.config.toml`);
    return {
      provider,
      method: 'profile-developer-instructions',
      files: [{ path: file, content: `developer_instructions = ${tomlString(text)}\n` }],
      argv: ['-p', profileName],
      cleanup: [file]
    };
  }

  throw new Error(`unsupported provider: ${provider}`);
}

function writePlan(plan) {
  for (const file of plan.files) {
    fs.mkdirSync(nodePath.dirname(file.path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file.path, file.content, { mode: 0o600 });
  }
}

function cleanupPlan(plan) {
  for (const target of plan.cleanup) fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { renderContext, planInjection, writePlan, cleanupPlan };
