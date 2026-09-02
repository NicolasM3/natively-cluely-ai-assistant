import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron');

const { LocalKnowledgeOrchestrator } = await import(
  pathToFileURL(path.join(distRoot, 'services/localProfile/LocalKnowledgeOrchestrator.js')).href
);
const { LOCAL_PROFILE_MEETING_ID } = await import(
  pathToFileURL(path.join(distRoot, 'services/localProfile/ProfileFolderIndexer.js')).href
);

function makeStructuredProfile() {
  return {
    identity: { name: 'Alex Example', role: 'Backend Engineer' },
    summary: 'Backend engineer with RAG experience.',
    skills: ['Go', 'Kafka', 'Langchain'],
    experience: [{ role: 'Engineer', company: 'ExampleCo', bullets: ['Built RAG bot'] }],
    projects: [{ name: 'RAG Bot', description: 'Support automation with retrieval' }],
    education: [{ institution: 'State University', degree: 'BS', field: 'Computer Science' }],
  };
}

test('processQuestion includes vector chunks and skips raw dump when retrieval hits', async () => {
  const orch = new LocalKnowledgeOrchestrator();
  orch.knowledgeMode = true;
  orch.setRAGManager({
    hasCorpusEmbeddings: (meetingId) => meetingId === LOCAL_PROFILE_MEETING_ID,
    getRetriever: () => ({
      retrieve: async () => ({
        chunks: [{
          speaker: 'notes/project-x.md',
          text: '[notes/project-x.md]\nBuilt a Langchain RAG assistant with 30% ticket reduction.',
        }],
        formattedContext: '',
        totalTokens: 40,
        meetingIds: [LOCAL_PROFILE_MEETING_ID],
        intent: 'open_question',
      }),
    }),
  });

  orch.activeResumeDoc = {
    id: 'local_profile_folder',
    structured_data: makeStructuredProfile(),
    raw_text: '# Raw\n'.repeat(5000),
  };

  const result = await orch.processQuestion('Tell me about your RAG project at ExampleCo');
  assert.ok(result?.contextBlock, 'expected a context block');
  assert.match(result.contextBlock, /candidate_profile_chunks/);
  assert.match(result.contextBlock, /Langchain RAG assistant/i);
  assert.doesNotMatch(result.contextBlock, /candidate_folder_source_text/);
  assert.match(result.contextBlock, /candidate_profile trust="user_uploaded_data"/);
});

test('processQuestion degrades gracefully when vector retrieval is unavailable', async () => {
  const orch = new LocalKnowledgeOrchestrator();
  orch.knowledgeMode = true;
  orch.setRAGManager(null);

  orch.activeResumeDoc = {
    id: 'local_profile_folder',
    structured_data: makeStructuredProfile(),
    raw_text: '# Raw resume text',
  };

  const result = await orch.processQuestion('Qual sua formação?');
  assert.ok(result?.contextBlock, 'structured block should still be returned');
  assert.doesNotMatch(result.contextBlock, /candidate_profile_chunks/);
  assert.match(result.contextBlock, /candidate_profile trust="user_uploaded_data"/);
});
