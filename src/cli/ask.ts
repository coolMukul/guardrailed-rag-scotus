#!/usr/bin/env node
import 'dotenv/config'; // Load .env file before anything else
import { retrieve } from '../retrieval/retrieve.js';
import { trace, span, flush } from '../obs/langfuse.js';
import { getSystemPrompt, getUserMessage } from '../prompts/generation.js';
import { validateWithRetry } from '../validator/retry.js';
import { generateWithStructuredOutputSafe } from '../generate/langchain-generator.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npm run cli -- ask "Your question"');
    process.exit(1);
  }

  const query = args.join(' ');

  console.log(`\nQuery: ${query}\n`);

  const result = await trace('ask_cli', async (t) => {
    // retrieve() applies RUNTIME knobs (top-k, rerank toggle) uniformly across
    // the server route, CLI, and eval runner.
    const retrieved = await span(t, 'retrieve', async () => {
      const outcome = await retrieve(query);
      return outcome.chunks;
    });

    console.log(`\nRetrieved ${retrieved.length} chunks:\n`);
    retrieved.forEach((r) => {
      console.log(`[${r.id}] (score: ${r.score.toFixed(3)}) - ${r.payload.case_name}`);
      console.log(`   Section: ${r.payload.section}`);
      if (r.payload.citation) console.log(`   Citation: ${r.payload.citation}`);
    });

    // Generate answer with guaranteed structured output via LangChain
    const systemPrompt = getSystemPrompt();
    const userMessage = getUserMessage(query, retrieved);

    // No explicit model: defaults to RUNTIME.modelName so runtime overrides apply.
    const parsedAnswer = await span(t, 'generate', async () => {
      return await generateWithStructuredOutputSafe(systemPrompt, userMessage);
    });

    // Validate with retry logic; the trace gives the grounding judge and any
    // regeneration their own spans
    const validationResult = await span(t, 'validate', async () => {
      return await validateWithRetry(parsedAnswer, retrieved, query, 1, t);
    });

    return validationResult;
  });

  // Format and display answer with citations
  console.log(`\n${'='.repeat(60)}`);
  console.log(`VALIDATION STATUS: ${result.status === 'valid' ? '✓ VALID' : '✗ INSUFFICIENT EVIDENCE'}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!result.answer) {
    console.log('❌ No valid answer generated.');
    console.log('   The model failed to produce structured JSON output.');
    console.log('   Even after retry with corrective feedback, parsing failed.\n');
  } else {
    console.log('Answer:\n');
    result.answer.answer_spans.forEach((span, idx) => {
      console.log(`${span.text}`);
      if (span.citation_ids.length > 0) {
        const citations = span.citation_ids.map((id) => {
          const citation = result.answer.citations.find((c) => c.chunk_id === id);
          return citation ? `${citation.case_name}${citation.citation ? ` ${citation.citation}` : ''}` : `[${id}]`;
        });
        console.log(`   [Citations: ${citations.join('; ')}]`);
      }
    });
  }

  console.log(`\nValidator Details:`);
  console.log(`  - Coverage check: ${result.coverage_verdict?.passed ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  - Grounding check: ${result.grounding_verdict?.passed ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  - Retry attempts: ${result.retry_attempts}`);
  console.log();
  await flush();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
