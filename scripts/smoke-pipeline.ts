/**
 * Smoke test for the full ask pipeline: retrieve -> generate -> validate,
 * for one in-corpus question (must come back valid with citations) and one
 * out-of-corpus question (must abstain or be rejected by the validators).
 * Needs Qdrant running with the scotus_opinions collection ingested.
 *
 * Usage:
 *   npm run smoke:pipeline
 *   npm run smoke:pipeline -- --provider gemini
 *
 * Exits 1 if either question produces an unexpected outcome.
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

const providerArg = argValue('--provider');
const modelArg = argValue('--model');
if (providerArg) {
  process.env.LLM_PROVIDER = providerArg;
  process.env.MODEL_NAME = modelArg ?? DEFAULT_MODEL_BY_PROVIDER[providerArg] ?? process.env.MODEL_NAME;
} else if (modelArg) {
  process.env.MODEL_NAME = modelArg;
}

const { RUNTIME } = await import('../src/config/runtime.js');
const { retrieve } = await import('../src/retrieval/retrieve.js');
const { getSystemPrompt, getUserMessage } = await import('../src/prompts/generation.js');
const { generateWithStructuredOutputSafe } = await import('../src/generate/langchain-generator.js');
const { validateWithRetry } = await import('../src/validator/retry.js');
const { flush } = await import('../src/obs/langfuse.js');

const ABSTAIN_PATTERN = /do(es)? not (contain|include|address|mention)|cannot (answer|be answered)|no (information|relevant)|not (covered|present) in/i;

async function askOnce(query: string) {
  const { chunks } = await retrieve(query);
  const answer = await generateWithStructuredOutputSafe(getSystemPrompt(), getUserMessage(query, chunks));
  const result = await validateWithRetry(answer, chunks, query, 1);
  return { chunks, result };
}

async function main() {
  console.log(`provider=${RUNTIME.provider} model=${RUNTIME.modelName} collection=${RUNTIME.collectionName}\n`);
  let failed = 0;

  // In-corpus: a 2024 case that is in the indexed opinions.
  {
    const query = 'What did the Court hold about Chevron deference in Loper Bright Enterprises v. Raimondo?';
    const { chunks, result } = await askOnce(query);
    const hitCase = chunks.some((c) => c.payload.case_name?.toLowerCase().includes('loper'));
    const cited = (result.answer?.citations?.length ?? 0) > 0;
    const ok = result.status === 'valid' && hitCase && cited;

    console.log(`${ok ? 'PASS' : 'FAIL'}  in-corpus (Loper Bright) — status=${result.status}`);
    console.log(
      `      retrieved=${chunks.length} hitExpectedCase=${hitCase} citations=${result.answer?.citations?.length ?? 0} ` +
        `coverage=${result.coverage_verdict?.passed} grounding=${result.grounding_verdict?.passed} retries=${result.retry_attempts}`,
    );
    if (!ok) failed++;
  }

  // Out-of-corpus: a fabricated case, so no real opinion can quote it (old
  // landmarks like Marbury get quoted inside modern in-corpus opinions and
  // can be legitimately answered). The system must either reject the answer
  // or explicitly say the excerpts don't cover it.
  {
    const query = 'What did the Court decide in Johnson v. Orbital Logistics (2030)?';
    const { result } = await askOnce(query);
    const answerText = result.answer?.answer_spans?.map((s) => s.text).join(' ') ?? '';
    const abstained = result.status !== 'valid' || ABSTAIN_PATTERN.test(answerText);

    console.log(`${abstained ? 'PASS' : 'FAIL'}  out-of-corpus (fabricated case) — status=${result.status}`);
    console.log(`      abstainedInText=${ABSTAIN_PATTERN.test(answerText)} answer="${answerText.slice(0, 120)}..."`);
    if (!abstained) failed++;
  }

  await flush();
  console.log(`\n${2 - failed}/2 questions as expected`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke-pipeline crashed:', err);
  process.exit(1);
});
