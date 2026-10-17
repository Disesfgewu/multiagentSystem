'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BUILTIN_SKILLS,
  validateSkill,
  loadResearchSkills,
  renderSkillsInstructions,
  renderAcademicEthicsRules,
  ACADEMIC_ETHICS_RULES,
  SkillError
} = require('../../src/research/skills');

test('built-in skills: paper-search, citation-verify, novelty-compare, findings-deliver, zhtw-research exist and are frozen', () => {
  const ids = Object.keys(BUILTIN_SKILLS).sort();
  assert.deepEqual(ids, ['citation-verify', 'findings-deliver', 'novelty-compare', 'paper-search', 'zhtw-research']);

  for (const skill of Object.values(BUILTIN_SKILLS)) {
    assert.ok(Object.isFrozen(skill), `${skill.id} must be frozen`);
    assert.ok(Object.isFrozen(skill.allowedTools), `${skill.id}.allowedTools must be frozen`);
    assert.match(skill.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.match(skill.version, /^\d+\.\d+\.\d+$/);
    assert.ok(skill.name.length > 0 && skill.name.length <= 120);
    assert.ok(skill.summary.length > 0 && skill.summary.length <= 500);
    assert.ok(skill.promptInstructions.length > 0);
    assert.ok(skill.academicEthics.length > 0);
  }
});

test('built-in skills tools are strictly read-only and contain no forbidden write tools', () => {
  for (const skill of Object.values(BUILTIN_SKILLS)) {
    for (const tool of skill.allowedTools) {
      assert.notEqual(tool.toolName, 'download_paper', `${skill.id} must not allow download_paper`);
      assert.notEqual(tool.toolName, 'write_file', `${skill.id} must not allow write_file`);
      assert.notEqual(tool.toolName, 'create_issue', `${skill.id} must not allow create_issue`);
      assert.notEqual(tool.toolName, 'merge_pull_request', `${skill.id} must not allow merge_pull_request`);
    }
  }
});

test('validateSkill rejects forbidden write tools fail-closed', () => {
  const base = {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    summary: 'Testing tool validation',
    allowedTools: [{ serverId: 'arxiv-mcp-server', toolName: 'download_paper' }],
    promptInstructions: 'Do testing.',
    academicEthics: 'Be ethical.'
  };

  assert.throws(
    () => validateSkill(base),
    (err) => err instanceof SkillError && err.code === 'write-tool-forbidden'
  );

  const writeGit = { ...base, allowedTools: [{ serverId: 'github-mcp-server', toolName: 'create_issue' }] };
  assert.throws(
    () => validateSkill(writeGit),
    (err) => err instanceof SkillError && err.code === 'write-tool-forbidden'
  );
});

test('validateSkill validates against catalog when provided', () => {
  const catalog = [
    {
      serverId: 'arxiv-mcp-server',
      tools: [
        { name: 'search_papers', readOnly: true },
        { name: 'download_paper', readOnly: false }
      ]
    }
  ];

  const good = {
    id: 'test-good',
    name: 'Good Skill',
    version: '1.0.0',
    summary: 'A valid skill',
    allowedTools: [{ serverId: 'arxiv-mcp-server', toolName: 'search_papers' }],
    promptInstructions: 'Valid instructions.',
    academicEthics: 'Valid ethics.'
  };
  const validated = validateSkill(good, { catalog });
  assert.equal(validated.id, 'test-good');

  const unknownServer = {
    ...good,
    allowedTools: [{ serverId: 'unknown-mcp', toolName: 'search_papers' }]
  };
  assert.throws(
    () => validateSkill(unknownServer, { catalog }),
    (err) => err instanceof SkillError && err.code === 'unknown-server-in-tool-reference'
  );

  const unknownTool = {
    ...good,
    allowedTools: [{ serverId: 'arxiv-mcp-server', toolName: 'nonexistent_tool' }]
  };
  assert.throws(
    () => validateSkill(unknownTool, { catalog }),
    (err) => err instanceof SkillError && err.code === 'unknown-tool-in-reference'
  );
});

test('validateSkill enforces field lengths and format checks', () => {
  assert.throws(() => validateSkill(null), { code: 'skill-invalid' });
  assert.throws(() => validateSkill({ id: 'Bad_ID' }), { code: 'skill-id-invalid' });
  assert.throws(() => validateSkill({ id: 'valid-id', version: 'latest' }), { code: 'skill-version-invalid' });
  assert.throws(() => validateSkill({ id: 'valid-id', version: '1.0.0', name: 'a\u0000b' }), { code: 'skill-name-invalid' });
  assert.throws(() => validateSkill({ id: 'valid-id', version: '1.0.0', name: 'Name', summary: 'x'.repeat(600) }), { code: 'skill-summary-invalid' });
});

test('loadResearchSkills ignores workspace skill overrides and issues warning', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Simulate an adversarial workspace trying to inject skills
  fs.mkdirSync(path.join(tmpDir, '.skills'));
  fs.writeFileSync(path.join(tmpDir, '.skills', 'fake-skill.json'), JSON.stringify({ id: 'malicious' }));

  const loaded = loadResearchSkills({ workspaceRoot: tmpDir });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.skills.length, 5, 'must return only reviewed built-in skills');
  assert.deepEqual(loaded.warnings, ['workspace-skill-override-forbidden'], 'must warn about workspace override attempt');

  // Verify none of the loaded skills contain the workspace injected id
  assert.equal(loaded.skills.some((s) => s.id === 'malicious'), false);
});

test('loadResearchSkills without workspace override loads cleanly with zero warnings', () => {
  const loaded = loadResearchSkills();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.skills.length, 5);
  assert.deepEqual(loaded.warnings, []);
});

test('renderSkillsInstructions formats Markdown representation containing all skills and tools', () => {
  const rendered = renderSkillsInstructions();
  assert.match(rendered, /## Approved Research Skills/);
  assert.match(rendered, /Paper Search & Screening/);
  assert.match(rendered, /Citation & Provenance Verification/);
  assert.match(rendered, /Novelty & Related Work Comparison/);
  assert.match(rendered, /Research Findings Delivery/);
  assert.match(rendered, /Traditional Chinese Terminology Review/);
  assert.match(rendered, /arxiv-mcp-server:search_papers/);
  assert.match(rendered, /github-mcp-server:get_file_contents/);
});

test('renderAcademicEthicsRules formats the 5 core ethics requirements', () => {
  const rendered = renderAcademicEthicsRules();
  assert.match(rendered, /## Academic Ethics & Integrity Requirements/);
  assert.match(rendered, /1\. Citation Provenance/);
  assert.match(rendered, /2\. Untrusted Literature Isolation/);
  assert.match(rendered, /3\. Retraction & Correction Transparency/);
  assert.match(rendered, /4\. Quote & Claim Veracity/);
  assert.match(rendered, /5\. Privacy & Sensitive Content Containment/);
  assert.equal(ACADEMIC_ETHICS_RULES.length, 5);
});
