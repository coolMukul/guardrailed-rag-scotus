/**
 * Minimal validator smoke test — no Qdrant required.
 *
 * Exercises both LangChain structured paths against the configured provider:
 *   1. generateWithStructuredOutput()  -> schema-validated Answer
 *   2. validateGroundingWithLLM()      -> per-span entailment verdicts
 *
 * Uses two hand-made chunks so it runs without the retrieval pipeline.
 * Run: npx tsx scripts/test-phase4.ts
 */

import 'dotenv/config';
import { CONFIG } from '../src/config/constants.js';
import { getSystemPrompt, getUserMessage } from '../src/prompts/generation.js';
import { generateWithStructuredOutput } from '../src/generate/langchain-generator.js';
import { validateGroundingWithLLM } from '../src/validator/grounding-judge.js';

const CHUNKS = [
  {
    id: 1887984097,
    score: 0.9,
    payload: {
      case_name: 'Miranda v. Arizona',
      citation: '384 U.S. 436 (1966)',
      section: 'majority',
      text:
        'The prosecution may not use statements stemming from custodial interrogation of the defendant ' +
        'unless it demonstrates the use of procedural safeguards effective to secure the privilege against ' +
        'self-incrimination. The person in custody must, prior to interrogation, be clearly informed that he ' +
        'has the right to remain silent, and that anything he says will be used against him in court; he must ' +
        'be clearly informed that he has the right to consult with a lawyer and to have the lawyer with him ' +
        'during interrogation, and that, if he is indigent, a lawyer will be appointed to represent him.',
    },
  },
  {
    id: 2100485910,
    score: 0.85,
    payload: {
      case_name: 'Miranda v. Arizona',
      citation: '384 U.S. 436 (1966)',
      section: 'majority',
      text:
        'If the individual indicates in any manner, at any time prior to or during questioning, that he wishes ' +
        'to remain silent, the interrogation must cease. If the individual states that he wants an attorney, ' +
        'the interrogation must cease until an attorney is present.',
    },
  },
];

async function main() {
  const query = 'What did Miranda hold?';
  console.log(`Provider: ${CONFIG.generation.provider}`);
  console.log(`Model:    ${CONFIG.generation.modelName}`);
  console.log(`Query:    ${query}\n`);

  // 1) Structured generation
  console.log('--- 1. generateWithStructuredOutput ---');
  const systemPrompt = getSystemPrompt();
  const userMessage = getUserMessage(query, CHUNKS);
  const answer = await generateWithStructuredOutput(systemPrompt, userMessage, CONFIG.generation.modelName as string);
  console.log('✓ Got schema-valid Answer with', answer.answer_spans.length, 'span(s):\n');
  answer.answer_spans.forEach((s, i) => {
    console.log(`  [${i}] "${s.text}"  cites=${JSON.stringify(s.citation_ids)}`);
  });

  // 2) Grounding judge
  console.log('\n--- 2. validateGroundingWithLLM ---');
  const grounding = await validateGroundingWithLLM(answer, CHUNKS);
  console.log(`✓ Grounding passed: ${grounding.passed} (model: ${grounding.model})`);
  if (grounding.issues.length > 0) {
    console.log(`  ${grounding.issues.length} issue(s):`);
    grounding.issues.forEach((iss) => {
      console.log(`   - span ${iss.spanIndex}: entails=${iss.entails} — ${iss.reason}`);
    });
  } else {
    console.log('  No grounding issues — all spans entailed.');
  }

  console.log('\n✅ Validator smoke test completed.');
}

main().catch((err) => {
  console.error('\n✗ Validator smoke test failed:', err);
  process.exit(1);
});
