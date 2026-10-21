import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const root = path.join(__dirname, '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

test('every reading a session reports is handed to the usage log, best effort, from the one change event', () => {
  const source = read('src/sessions/sessionCommands.ts');
  assert.match(source, /observations\.onDidChange\(\(sessionId\) => \{ changed\.fire\(\); void recordUsage\(sessionId\); \}\)/);
  assert.match(source, /await recordReading\(\{ snapshot: observations\.enrich\(\[view\]\)\[0\]\?\.providerObservation/);
  assert.equal([...source.matchAll(/await recordReading\(/g)].length, 1, 'one place keeps readings');
});

test('the usage log commands only read the private log and open text: nothing is written to a file, sent or published', () => {
  const source = read('src/accounts/usageLogCommands.ts');
  assert.doesNotMatch(source, /node:fs|writeFile|appendFile|createWriteStream|child_process|fetch\(|https?:/, 'no file, process or network access');
  assert.doesNotMatch(source, /\.append\(|recordDelivery|\.put\(/, 'it never writes to the log');
  assert.match(source, /openTextDocument\(\{ content:/, 'an export opens an untitled editor');
  assert.match(source, /exportRows\(read\.entries\)/, 'exports are always the masked rows');
  assert.doesNotMatch(source, /toCsv\(read\.entries\)|toJson\(read\.entries\)/, 'never the raw entries');
});

test('both commands are contributed and activate the extension; the account row links to the log', () => {
  const manifest = JSON.parse(read('package.json'));
  for (const id of ['multiagentSystem.usage.showLog', 'multiagentSystem.usage.exportLog']) {
    assert.ok(manifest.contributes.commands.some((command: { command: string }) => command.command === id), id);
    assert.ok(manifest.activationEvents.includes(`onCommand:${id}`), id);
  }
  const accounts = read('src/accounts/accountCommands.ts');
  assert.match(accounts, /command: 'multiagentSystem\.usage\.showLog'/);
  assert.match(accounts, /if \(item instanceof AccountItem\)/);
});
