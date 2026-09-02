// Portuguese profile question routing — reproduces live manual-chat failures where
// PT questions fell through to unknown_answer and skipped profile JIT evidence.
//
// Run: npm run build:electron, then node --test on this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(__dirname, rel)).href);

const { planAnswer } = await load('../../../dist-electron/electron/llm/AnswerPlanner.js');
const { buildManualProfileEvidenceRoute } = await load('../../../dist-electron/electron/llm/profileAnswerBackend.js');

const FIXTURE_PROFILE = {
  identity: { name: 'Nicolas Oliveira', role: 'Software Engineer' },
  education: [{ institution: 'UFMG', degree: 'Computer Science' }],
  skills: { languages: ['Go', 'Kotlin', 'Python', 'TypeScript'] },
  experience: [{ company: 'iFood', role: 'Engineer' }],
  projects: [{ name: 'Natively', title: 'Natively' }],
};

const orchestrator = {
  activeResume: { structured_data: FIXTURE_PROFILE },
  activeJD: null,
};

describe('Portuguese profile routing', () => {
  const cases = [
    ['Qual sua formação?', 'profile_fact_answer'],
    ['Quais são as suas formações?', 'profile_fact_answer'],
    ['Qual tecnologia já trabalhou?', 'skills_answer'],
  ];

  for (const [question, expectedType] of cases) {
    test(`planAnswer: "${question}" → ${expectedType}`, () => {
      const plan = planAnswer({ question, source: 'manual_input', speakerPerspective: 'user' });
      assert.equal(plan.answerType, expectedType, `expected ${expectedType}, got ${plan.answerType}`);
      assert.notEqual(plan.profileContextPolicy, 'forbidden');
    });

    test(`profile evidence: "${question}" selects resume facts`, () => {
      const plan = planAnswer({ question, source: 'manual_input', speakerPerspective: 'user' });
      const { route } = buildManualProfileEvidenceRoute({
        question,
        orchestrator,
        source: 'manual_input',
        answerType: plan.answerType,
      });
      assert.ok(route, `expected profile evidence route for "${question}"`);
      assert.ok(route.items.length > 0, 'expected at least one evidence item');
    });
  }
});
