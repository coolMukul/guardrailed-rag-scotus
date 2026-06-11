/**
 * Smoke test for the LLM layer: one structured-output generation call and one
 * grounding-judge call against two fixed in-memory chunks (no Qdrant needed).
 *
 * Usage:
 *   npm run smoke:llm                                  # provider/model from .env
 *   npm run smoke:llm -- --provider groq               # groq + default llama model
 *   npm run smoke:llm -- --provider gemini --model gemini-3.1-flash-lite-preview
 *
 * Checks:
 *   1. Generation returns a schema-valid Answer (spans + citations)
 *   2. Every span carries at least one citation_id from the provided chunks
 *   3. Grounding judge returns a real verdict (not the fail-open fallback)
 *   4. Token usage was recorded for the calls (rate/cost accounting works)
 *
 * Exits 1 if any check fails.
 */

import 'dotenv/config';

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-3.1-flash-lite-preview',
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Apply provider/model overrides BEFORE importing app modules, so both the
// frozen CONFIG and the RUNTIME defaults pick them up.
const providerArg = argValue('--provider');
const modelArg = argValue('--model');
if (providerArg) {
  process.env.LLM_PROVIDER = providerArg;
  process.env.MODEL_NAME = modelArg ?? DEFAULT_MODEL_BY_PROVIDER[providerArg] ?? process.env.MODEL_NAME;
} else if (modelArg) {
  process.env.MODEL_NAME = modelArg;
}

const { RUNTIME } = await import('../src/config/runtime.js');
const { generateWithStructuredOutput } = await import('../src/generate/langchain-generator.js');
const { validateGroundingWithLLM } = await import('../src/validator/grounding-judge.js');
const { getSystemPrompt, getUserMessage } = await import('../src/prompts/generation.js');
const { resetUsage, getUsageTotals } = await import('../src/obs/usage.js');

const CHUNKS = [
  {
    id: 111222333,
    score: 0.95,
    payload: {
      text:
        'Miranda v. Arizona requires that, before custodial interrogation, police must inform the suspect ' +
        'of the right to remain silent and the right to counsel. Statements obtained in violation of these ' +
        "warnings are inadmissible in the prosecution's case in chief.",
      case_name: 'Miranda v. Arizona',
      citation: '384 U.S. 436 (1966)',
      section: 'majority',
    },
  },
  {
    id: 444555666,
    score: 0.9,
    payload: {
      text:
        'The warnings requirement applies only to custodial interrogation. Voluntary statements made ' +
        'outside custody are not affected by the rule.',
      case_name: 'Miranda v. Arizona',
      citation: '384 U.S. 436 (1966)',
      section: 'majority',
    },
  },
];

const QUESTION = 'According to the excerpts, what must police do before custodial interrogation?';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

async function main() {
  console.log(`provider=${RUNTIME.provider} model=${RUNTIME.modelName}\n`);
  const checks: Check[] = [];

  resetUsage();

  // 1-2: structured generation
  let answer = null;
  try {
    answer = await generateWithStructuredOutput(getSystemPrompt(), getUserMessage(QUESTION, CHUNKS));
  } catch (err) {
    checks.push({
      name: 'generation: schema-valid answer',
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (answer) {
    checks.push({
      name: 'generation: schema-valid answer',
      passed: answer.answer_spans.length > 0,
      detail: `${answer.answer_spans.length} span(s), ${answer.citations.length} citation(s)`,
    });

    const knownIds = new Set(CHUNKS.map((c) => c.id));
    const allCited = answer.answer_spans.every(
      (s) => s.citation_ids.length > 0 && s.citation_ids.every((id) => knownIds.has(id)),
    );
    checks.push({
      name: 'generation: every span cites a provided chunk',
      passed: allCited,
      detail: answer.answer_spans.map((s) => `[${s.citation_ids.join(',')}]`).join(' '),
    });

    // 3: grounding judge (fail-open fallback omits `model`, so its presence
    // distinguishes a real verdict from a swallowed error)
    const verdict = await validateGroundingWithLLM(answer, CHUNKS);
    checks.push({
      name: 'judge: returned a real verdict',
      passed: verdict.model !== undefined,
      detail: `passed=${verdict.passed} issues=${verdict.issues.length}${verdict.model ? '' : ' (fail-open fallback hit)'}`,
    });
  }

  // 4: token accounting
  const usage = getUsageTotals();
  checks.push({
    name: 'usage: tokens recorded for LLM calls',
    passed: usage.totalTokens > 0,
    detail: `calls=${usage.calls} in=${usage.inputTokens} out=${usage.outputTokens} cached=${usage.cachedInputTokens}`,
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
    if (!c.passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke-llm crashed:', err);
  process.exit(1);
});
