import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { modelArguments, normalizeRequestedModel, supportsModelSelection } from '../../src/providers/modelSelection';

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
  for (const value of ['', ' ', ' model', 'model ', '--yolo', '-m', 'model;echo', 'model&echo', 'model|echo', '$(echo)', '`echo`', '$MODEL', 'model\nother', 'model\u202E', 'model[1m]', 'a'.repeat(129), 7, {}, []]) {
    assert.throws(() => normalizeRequestedModel('claude', value), { code: 'invalid-model' }, String(value));
  }
});
