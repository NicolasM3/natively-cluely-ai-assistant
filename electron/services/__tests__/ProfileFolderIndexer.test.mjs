import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron');

const { chunkProfileDocuments } = await import(
  pathToFileURL(path.join(distRoot, 'services/localProfile/profileDocumentChunker.js')).href
);

test('chunkProfileDocuments splits markdown sections with file prefix', () => {
  const chunks = chunkProfileDocuments([
    {
      relativePath: 'notes/project-x.md',
      fileName: 'project-x.md',
      content: '# Project X\nBuilt a RAG assistant with Langchain.\n\n## Impact\nReduced ticket time by 30%.',
    },
  ]);

  assert.ok(chunks.length >= 1, 'expected at least one chunk');
  assert.match(chunks[0].text, /\[notes\/project-x\.md\]/);
  assert.match(chunks[0].text, /RAG assistant/i);
});
