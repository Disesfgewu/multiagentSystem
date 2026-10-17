'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guardOutboundQuery, MAX_QUERY_CHARS, LIMITATIONS } = require('../../src/research/query-guard');

const TOKEN = 'ghp_syntheticsyntheticsynthetic1234';
const clear = () => ({ status: 'clear', blocked: false, findings: [] });

test('a plain topic query is allowed, and the result says what the scan cannot see', () => {
  const result = guardOutboundQuery('prompt injection defenses for tool-using agents');
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'allowed');
  assert.deepEqual(result.findings, []);
  assert.deepEqual([...result.limitations], [...LIMITATIONS]);
  assert.ok(result.limitations.includes('human-review-still-required'));
  assert.equal(Object.isFrozen(result), true);
});

test('a synthetic token, private value or local path is refused, and no matched text is returned', () => {
  const home = ['', 'Users', 'someone', 'project'].join('/');
  const cases = [
    `survey ${TOKEN}`,
    `agents in ${home}`,
    'my-private-account-label-123 agents'
  ];
  for (const query of cases) {
    const result = guardOutboundQuery(query, { knownValues: [{ id: 'label', value: 'my-private-account-label-123' }] });
    assert.equal(result.allowed, false, query);
    assert.equal(result.reason, 'scan-blocked');
    assert.ok(result.findings.length > 0);
    const serialized = JSON.stringify(result);
    for (const secret of [TOKEN, 'someone', 'my-private-account-label-123']) assert.equal(serialized.includes(secret), false, 'result never echoes the query');
    for (const finding of result.findings) assert.deepEqual(Object.keys(finding).sort(), ['category', 'code']);
  }
});

test('private memory fragments are matched when the caller supplies them', () => {
  const content = 'the internal rollout plan names three customers and a launch date in march';
  const result = guardOutboundQuery('the internal rollout plan names three customers and a launch date in march', { memories: [{ id: 'm1', content }] });
  assert.equal(result.allowed, false);
});

test('bad input is refused: not a string, empty, too long, or with control and hidden characters', () => {
  for (const query of [undefined, null, 5, {}, [], '', '   ', '\n']) {
    assert.deepEqual([guardOutboundQuery(query).allowed, guardOutboundQuery(query).reason], [false, 'query-invalid'], String(query));
  }
  assert.equal(guardOutboundQuery('a'.repeat(MAX_QUERY_CHARS + 1)).reason, 'query-too-long');
  assert.equal(guardOutboundQuery('a'.repeat(MAX_QUERY_CHARS)).allowed, true);
  assert.equal(guardOutboundQuery('abcdef', { maxChars: 3 }).reason, 'query-too-long');
  assert.equal(guardOutboundQuery('a'.repeat(MAX_QUERY_CHARS + 1), { maxChars: 1e9 }).reason, 'query-too-long', 'a caller cannot raise the module limit');
  for (const query of ['topic\u0000', 'topic\u202Eevil', 'to\u200Bpic', 'topic\nsecond line', 'topic\u2028x']) {
    assert.equal(guardOutboundQuery(query).reason, 'query-control-characters', JSON.stringify(query));
  }
  for (const options of [null, 'x', 7, []]) assert.equal(guardOutboundQuery('graph neural networks', options).allowed, true);
});

test('a URL query must be https, without credentials, and named by a DNS host', () => {
  assert.equal(guardOutboundQuery('https://arxiv.org/abs/2401.00001').allowed, true);
  const refused = [
    'http://arxiv.org/abs/2401.00001',
    'ftp://arxiv.org/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@arxiv.org/abs/1',
    'https://user@arxiv.org/abs/1',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://service.localhost/x',
    'https://',
    'mailto:someone@example.org'
  ];
  for (const query of refused) {
    const result = guardOutboundQuery(query);
    assert.equal(result.allowed, false, query);
    assert.equal(result.reason, 'url-not-allowed', query);
  }
});

test('allowed hosts are an exact match: no suffix, prefix, port trick or wildcard', () => {
  const allowedHosts = ['arxiv.org', 'api.crossref.org'];
  assert.equal(guardOutboundQuery('https://arxiv.org/abs/1', { allowedHosts }).allowed, true);
  assert.equal(guardOutboundQuery('https://api.crossref.org/works/10.1/x', { allowedHosts }).allowed, true);
  for (const query of ['https://evil.arxiv.org/x', 'https://arxiv.org.evil.example/x', 'https://notarxiv.org/x', 'https://export.arxiv.org/x']) {
    assert.equal(guardOutboundQuery(query, { allowedHosts }).reason, 'host-not-allowed', query);
  }
  assert.equal(guardOutboundQuery('https://*.arxiv.org/x', { allowedHosts: ['*.arxiv.org'] }).allowed, false);
  for (const bad of ['arxiv.org', null, [1], [{}]]) assert.equal(guardOutboundQuery('https://arxiv.org/abs/1', { allowedHosts: bad }).reason, 'host-not-allowed', String(bad));
  assert.equal(guardOutboundQuery('https://arxiv.org/abs/1', { allowedHosts: [] }).reason, 'host-not-allowed', 'an empty list allows no host');
});

test('a URL that carries a secret in its path or query string is still scanned', () => {
  const result = guardOutboundQuery(`https://arxiv.org/search?q=agents&key=${TOKEN}`);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'scan-blocked');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('the scanner failing closed: throws, odd shapes, errors and incomplete scans all mean not allowed', () => {
  const secretInError = () => { throw new Error(`failed on ${TOKEN}`); };
  const thrown = guardOutboundQuery('graph neural networks', { scan: secretInError });
  assert.deepEqual([thrown.allowed, thrown.reason], [false, 'scanner-failed']);
  assert.equal(JSON.stringify(thrown).includes(TOKEN), false, 'an error message is never passed on');

  for (const odd of [undefined, null, 'clear', 7, {}, { status: 'clear' }, { status: 'clear', findings: 'none' }, { status: 'unknown', blocked: false, findings: [] }, { status: 'clear', blocked: true, findings: [] }, { status: 'clear', findings: [] }]) {
    const result = guardOutboundQuery('graph neural networks', { scan: () => odd });
    assert.equal(result.allowed, false, JSON.stringify(odd));
    assert.equal(result.reason, 'scanner-failed', JSON.stringify(odd));
  }
  assert.equal(guardOutboundQuery('graph neural networks', { scan: () => ({ status: 'error', blocked: true, findings: [] }) }).reason, 'scanner-failed');
  assert.equal(guardOutboundQuery('graph neural networks', { scan: () => ({ status: 'incomplete', blocked: true, findings: [] }) }).reason, 'scan-incomplete');
  assert.equal(guardOutboundQuery('graph neural networks', { scan: () => ({ status: 'clear', blocked: false, findings: [{ code: 'x', category: 'credential' }] }) }).allowed, false, 'a finding blocks even when the status says clear');
  assert.equal(guardOutboundQuery('graph neural networks', { scan: clear }).allowed, true);
});

test('only the query text is handed to the scanner, as one broker payload, with the private reference', () => {
  let seen;
  const memories = [{ id: 'm', content: 'x'.repeat(80) }];
  guardOutboundQuery('  graph neural networks  ', { memories, rules: [], knownValues: [], scan: (units, options) => { seen = { units, options }; return clear(); } });
  assert.deepEqual(seen.units, [{ kind: 'broker-payload', text: 'graph neural networks' }]);
  assert.equal(seen.options.memories, memories);
});

test('findings from a custom scanner are reduced to code and category', () => {
  const result = guardOutboundQuery('graph neural networks', {
    scan: () => ({ status: 'blocked', blocked: true, findings: [{ code: 'github-token', category: 'credential', hint: TOKEN, line: 1, column: 2, snippet: TOKEN }, null, { code: 5 }] })
  });
  assert.equal(result.reason, 'scan-blocked');
  assert.deepEqual(result.findings.map((f) => ({ ...f })), [{ code: 'github-token', category: 'credential' }]);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('the module is pure: it imports only the scanner and touches no network, disk, process or environment', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'research', 'query-guard.js'), 'utf8');
  const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  assert.deepEqual(requires, ['../publish/scan']);
  const code = source.replace(/\/\/.*$/gm, '');
  assert.equal(/\b(?:fetch|XMLHttpRequest|WebSocket|process\.env|child_process)\b/.test(code), false);
  assert.equal(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/.test(source), false, 'no hidden or direction-changing characters');
});
