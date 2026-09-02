import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { parseLocalProfileFiles, stripHtml, profileDisplayName } = await import(
  pathToFileURL(path.resolve(__dirname, '../localProfile/localProfileParser.ts')).href
);

test('stripHtml removes tags and keeps readable text', () => {
  const html = '<h1>Nicolas Martins de Oliveira</h1><p>Software Engineer at iFood</p>';
  const text = stripHtml(html);
  assert.match(text, /Nicolas Martins de Oliveira/);
  assert.match(text, /Software Engineer at iFood/);
  assert.doesNotMatch(text, /<h1>/);
});

test('parseLocalProfileFiles builds profile from html + markdown + csv', () => {
  const parsed = parseLocalProfileFiles([
    {
      relativePath: 'nicolas-oliveira.html',
      fileName: 'nicolas-oliveira.html',
      content: '<h1>Nicolas Martins de Oliveira</h1><p>Software Engineer</p><p>Experience at iFood with Go, Kotlin, Kafka, AWS.</p>',
    },
    {
      relativePath: 'cracking-code-interview/nicolas-about-yourself.md',
      fileName: 'nicolas-about-yourself.md',
      content: 'I built an AI support bot using Langchain with RAG and achieved 30% reduction in ticket time.',
    },
    {
      relativePath: 'projects-big3.csv',
      fileName: 'projects-big3.csv',
      content: 'Challenges,SAGA Orchestrator,Langchain bot,Marketing platform',
    },
  ], '/tmp/nicolas-oliveira');

  assert.ok(parsed, 'expected parsed profile');
  assert.ok(profileDisplayName(parsed.structured), 'expected a display name');
  assert.match(parsed.structured.supplementary_context || '', /Langchain/);
  assert.match(parsed.rawText, /nicolas-about-yourself\.md/);
});
