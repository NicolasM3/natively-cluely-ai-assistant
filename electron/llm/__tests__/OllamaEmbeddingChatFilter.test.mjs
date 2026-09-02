// Embedding-only Ollama models (nomic-embed-text) must never be auto-selected for /api/chat.

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

const { isOllamaEmbeddingOnlyModel, filterOllamaChatModels } = require(dist('llm/modelCapabilities.js'));
const { LLMHelper } = require(dist('LLMHelper.js'));

const realFetch = globalThis.fetch;
function stubDaemon({ up = true } = {}) {
  globalThis.fetch = async (url) => {
    if (!up) throw new Error('ECONNREFUSED');
    if (String(url).includes('/api/show')) {
      return { ok: true, json: async () => ({ capabilities: ['completion'], name: 'test' }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}
function restoreDaemon() { globalThis.fetch = realFetch; }

describe('isOllamaEmbeddingOnlyModel', () => {
  test('flags nomic-embed-text', () => {
    assert.equal(isOllamaEmbeddingOnlyModel('nomic-embed-text:latest'), true);
  });
  test('allows chat models', () => {
    assert.equal(isOllamaEmbeddingOnlyModel('gemma4:12b'), false);
    assert.equal(isOllamaEmbeddingOnlyModel('llama3.2'), false);
  });
});

describe('probeOllama skips embedding-only models', () => {
  beforeEach(() => stubDaemon());
  afterEach(() => restoreDaemon);

  test('selects a chat model when embed model is listed first', async () => {
    const h = new LLMHelper('key', false, 'nomic-embed-text:latest', 'http://127.0.0.1:11434');
    h.getOllamaModels = async () => ['nomic-embed-text:latest', 'gemma4:12b'];
    const ok = await h.ensureOllamaModelSelected(false);
    assert.equal(ok, true);
    assert.equal(h.ollamaModel, 'gemma4:12b');
  });

  test('fails closed when only embedding models are installed', async () => {
    const h = new LLMHelper('key', false, 'nomic-embed-text:latest', 'http://127.0.0.1:11434');
    h.getOllamaModels = async () => ['nomic-embed-text:latest'];
    const ok = await h.ensureOllamaModelSelected(false);
    assert.equal(ok, false);
  });
});

describe('filterOllamaChatModels', () => {
  test('removes embed models from UI lists', () => {
    assert.deepEqual(
      filterOllamaChatModels(['nomic-embed-text:latest', 'qwen2.5:4b']),
      ['qwen2.5:4b'],
    );
  });
});
