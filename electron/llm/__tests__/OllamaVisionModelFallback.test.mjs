// When the selected Ollama model is text-only, image requests must dispatch to an
// installed vision model without mutating the user's Settings selection.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = (p) => path.join(__dirname, '../../../dist-electron/electron', p);

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { isReady: () => true, getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { LLMHelper } = require(dist('LLMHelper.js'));

const realFetch = globalThis.fetch;
function stubDaemon() {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ capabilities: ['completion'] }) });
}
function restoreDaemon() { globalThis.fetch = realFetch; }

function helper({ selected, models, visionModel = 'qwen3-vl:8b-instruct' }) {
  const h = Object.create(LLMHelper.prototype);
  h.useOllama = true;
  h.ollamaUrl = 'http://127.0.0.1:11434';
  h.ollamaModel = selected;
  h.ollamaVisionModel = null;
  h.getOllamaModels = async () => models;
  h.isProviderDisabled = () => false;
  h.refreshOllamaVisionModel = async () => {
    for (const m of models) {
      if (m === visionModel) return visionModel;
      if (/qwen3-vl|llava|gemma3|gemma4/i.test(m)) return m;
    }
    return null;
  };
  return h;
}

describe('probeOllama with text-only selection + vision installed', () => {
  beforeEach(() => stubDaemon());
  afterEach(() => restoreDaemon);

  test('needsVision=true is ok when a vision model is installed', async () => {
    const h = helper({
      selected: 'gpt-oss:20b',
      models: ['gpt-oss:20b', 'qwen3-vl:8b-instruct'],
    });
    const { ok, model } = await LLMHelper.prototype.probeOllama.call(h, true);
    assert.equal(ok, true);
    assert.equal(model, 'qwen3-vl:8b-instruct');
  });

  test('needsVision=false still uses the selected text model', async () => {
    const h = helper({
      selected: 'gpt-oss:20b',
      models: ['gpt-oss:20b', 'qwen3-vl:8b-instruct'],
    });
    const { ok, model } = await LLMHelper.prototype.probeOllama.call(h, false);
    assert.equal(ok, true);
    assert.equal(model, 'gpt-oss:20b');
  });
});

describe('ensureOllamaModelSelected does not override valid text selection for vision', () => {
  beforeEach(() => stubDaemon());
  afterEach(() => restoreDaemon);

  test('keeps gpt-oss selected while reporting vision availability', async () => {
    const h = helper({
      selected: 'gpt-oss:20b',
      models: ['gpt-oss:20b', 'qwen3-vl:8b-instruct'],
    });
    const ok = await LLMHelper.prototype.ensureOllamaModelSelected.call(h, true);
    assert.equal(ok, true);
    assert.equal(h.ollamaModel, 'gpt-oss:20b');
  });
});

describe('resolveOllamaDispatchModel', () => {
  beforeEach(() => stubDaemon());
  afterEach(() => restoreDaemon);

  test('text turn uses the selected model', async () => {
    const h = helper({
      selected: 'gpt-oss:20b',
      models: ['gpt-oss:20b', 'qwen3-vl:8b-instruct'],
    });
    const model = await LLMHelper.prototype.resolveOllamaDispatchModel.call(h, false);
    assert.equal(model, 'gpt-oss:20b');
    assert.equal(h.ollamaModel, 'gpt-oss:20b');
  });

  test('image turn falls back to the vision model without mutating selection', async () => {
    const h = helper({
      selected: 'gpt-oss:20b',
      models: ['gpt-oss:20b', 'qwen3-vl:8b-instruct'],
    });
    const model = await LLMHelper.prototype.resolveOllamaDispatchModel.call(h, true);
    assert.equal(model, 'qwen3-vl:8b-instruct');
    assert.equal(h.ollamaModel, 'gpt-oss:20b');
  });

  test('image turn uses the active model when it already supports vision', async () => {
    const h = helper({
      selected: 'qwen3-vl:8b-instruct',
      models: ['gpt-oss:20b', 'qwen3-vl:8b-instruct'],
      visionModel: 'qwen3-vl:8b-instruct',
    });
    const model = await LLMHelper.prototype.resolveOllamaDispatchModel.call(h, true);
    assert.equal(model, 'qwen3-vl:8b-instruct');
  });

  test('returns null when no vision model is installed', async () => {
    const h = helper({
      selected: 'gpt-oss:20b',
      models: ['gpt-oss:20b'],
    });
    h.refreshOllamaVisionModel = async () => null;
    const model = await LLMHelper.prototype.resolveOllamaDispatchModel.call(h, true);
    assert.equal(model, null);
  });
});
