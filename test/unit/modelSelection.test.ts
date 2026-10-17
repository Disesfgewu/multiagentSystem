import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { modelArguments, normalizeRequestedModel, supportsModelSelection, knownModelsForProvider } from '../../src/providers/modelSelection';

test('documented providers request one model argument; no request preserves CLI defaults', () => {
  for (const provider of ['claude', 'codex']) {
    assert.equal(supportsModelSelection(provider), true);
    for (const model of ['sonnet', 'provider/model-1.2:latest', 'custom_model']) {
      assert.deepEqual(modelArguments(provider, model), ['--model', model]);
    }
    assert.deepEqual(modelArguments(provider, null), []);
    assert.deepEqual(modelArguments(provider, undefined), []);
  }
  assert.equal(supportsModelSelection('agy'), false);
  assert.deepEqual(modelArguments('agy', null), []);
  assert.throws(() => modelArguments('agy', 'example'), { code: 'model-selection-unsupported' });
});

test('model identifiers cannot inject shell syntax or CLI options', () => {
  for (const value of ['', ' ', ' model', 'model ', '--yolo', '-m', 'model;echo', 'model&echo', 'model|echo', '$(echo)', '`echo`', '$MODEL', 'model\nother', 'model\n', 'model\r', 'model\r\n', 'model\u202E', 'model[1m]', 'a'.repeat(129), 7, {}, []]) {
    assert.throws(() => normalizeRequestedModel('claude', value), { code: 'invalid-model' }, String(value));
  }
});

test('knownModelsForProvider returns documented models for claude and codex and empty for agy', () => {
  const claudeModels = knownModelsForProvider('claude');
  assert.ok(claudeModels.length >= 4);
  assert.ok(claudeModels.some((m) => m.id === 'claude-3-7-sonnet-20250219'));
  assert.ok(claudeModels.some((m) => m.id === 'claude-3-5-sonnet-20241022'));
  for (const m of claudeModels) {
    assert.equal(normalizeRequestedModel('claude', m.id), m.id);
    assert.ok(m.description.length > 0);
  }

  const codexModels = knownModelsForProvider('codex');
  assert.ok(codexModels.length >= 4);
  assert.ok(codexModels.some((m) => m.id === 'o3-mini'));
  assert.ok(codexModels.some((m) => m.id === 'o1'));
  for (const m of codexModels) {
    assert.equal(normalizeRequestedModel('codex', m.id), m.id);
    assert.ok(m.description.length > 0);
  }

  assert.deepEqual(knownModelsForProvider('agy'), []);
  assert.deepEqual(knownModelsForProvider('unknown-provider'), []);
});
