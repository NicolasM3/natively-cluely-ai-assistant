// electron/llm/__tests__/GeminiProbe.test.mjs
//
// Settings → Test Connection for Gemini must not pin a hot generateContent model.
// 503 "high demand" and proxy latency are not invalid-key signals.
//
// Run: npm run build:electron, then node --test on this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(__dirname, rel)).href);

const { classifyGeminiProbeError } = await load('../../../dist-electron/electron/llm/geminiModels.js');

describe('classifyGeminiProbeError', () => {
  test('403 / API_KEY_INVALID → key-bad', () => {
    assert.equal(
      classifyGeminiProbeError({ response: { status: 403, data: { error: { message: 'API_KEY_INVALID' } } } }),
      'key-bad',
    );
  });

  test('503 high demand → key-ok (auth succeeded, model tier busy)', () => {
    assert.equal(
      classifyGeminiProbeError({
        response: {
          status: 503,
          data: { error: { message: 'This model is currently experiencing high demand.' } },
        },
      }),
      'key-ok',
    );
  });

  test('timeout → inconclusive', () => {
    assert.equal(
      classifyGeminiProbeError({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' }),
      'inconclusive',
    );
  });
});
