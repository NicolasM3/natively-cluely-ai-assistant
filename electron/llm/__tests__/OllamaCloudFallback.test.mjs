// Cloud→local Ollama fallback (2026-08-28).
//
// When Gemini is the selected provider, installed Ollama must still be reachable
// as a last-resort fallback without making Ollama the primary selection.

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
const { routeLLMProviders } = require(dist('llm/ProviderRouter.js'));

const realFetch = globalThis.fetch;
function stubDaemon({ up = true, vision = false } = {}) {
  globalThis.fetch = async (url, init) => {
    if (!up) throw new Error('ECONNREFUSED');
    const u = String(url);
    if (u.includes('/api/show')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const caps = vision ? ['completion', 'vision'] : ['completion'];
      return { ok: true, json: async () => ({ capabilities: caps, name: body.name }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}
function restoreDaemon() { globalThis.fetch = realFetch; }

function cloudPrimaryHelper({ models = ['gemma4:12b'], vision = true } = {}) {
  const h = new LLMHelper('fake-gemini-key', false, 'gemma4:12b', 'http://127.0.0.1:11434');
  h.currentModelId = 'gemini-3.7-flash';
  h.getOllamaModels = async () => models;
  h.probeOllamaVision = async (id) => vision && /gemma4|llava|gemma3/i.test(id);
  return h;
}

describe('seedOllamaFallbackConfig', () => {
  test('sets url/model without selecting Ollama as primary', () => {
    const h = new LLMHelper('key', false);
    assert.equal(h.isUsingOllama?.() ?? h.useOllama, false);
    h.seedOllamaFallbackConfig('http://localhost:11434', 'gemma4:12b');
    assert.equal(h.ollamaUrl, 'http://127.0.0.1:11434');
    assert.equal(h.ollamaModel, 'gemma4:12b');
    assert.equal(h.useOllama, false);
  });
});

describe('canUseLocalFallback vs scopeFallbackAvailable', () => {
  beforeEach(() => stubDaemon({ up: true, vision: true }));
  afterEach(() => restoreDaemon);

  test('installed Ollama is a cloud fallback candidate even when not selected', async () => {
    const h = cloudPrimaryHelper();
    assert.equal(await h.canUseLocalFallback(false), true);
    assert.equal(await h.scopeFallbackAvailable(false), false);
  });

  test('disabled ollama provider is not a cloud fallback candidate', async () => {
    const h = cloudPrimaryHelper();
    h.getDisabledProviderFamilies = () => ['ollama'];
    assert.equal(await h.canUseLocalFallback(false), false);
  });
});

describe('routeLLMProviders includes Ollama for cloud-primary fallback', () => {
  test('hasOllama true when cloud primary but local installed', () => {
    const attempts = routeLLMProviders({
      capability: 'chat',
      multimodal: false,
      availability: {
        hasGemini: true,
        hasOllama: true,
      },
      models: { geminiFlash: 'gemini-3.7-flash', ollama: 'gemma4:12b' },
    });
    const ollama = attempts.find((a) => a.provider === 'ollama');
    assert.ok(ollama, 'Ollama must appear in the provider chain');
    assert.equal(ollama.status, 'available');
  });

  test('hasOllama false when not installed', () => {
    const attempts = routeLLMProviders({
      capability: 'chat',
      multimodal: false,
      availability: {
        hasGemini: true,
        hasOllama: false,
      },
      models: { geminiFlash: 'gemini-3.7-flash' },
    });
    assert.equal(attempts.some((a) => a.provider === 'ollama'), false);
  });
});

describe('refreshOllamaVisionModel when Ollama is not selected', () => {
  beforeEach(() => stubDaemon({ up: true, vision: true }));
  afterEach(() => restoreDaemon);

  test('resolves vision model for cloud-primary fallback', async () => {
    const h = cloudPrimaryHelper({ models: ['qwen2.5-coder:7b', 'gemma4:12b'], vision: true });
    const resolved = await h.refreshOllamaVisionModel();
    assert.equal(resolved, 'gemma4:12b');
  });

  test('returns null when ollama provider is disabled', async () => {
    const h = cloudPrimaryHelper();
    h.getDisabledProviderFamilies = () => ['ollama'];
    const resolved = await h.refreshOllamaVisionModel();
    assert.equal(resolved, null);
  });
});
