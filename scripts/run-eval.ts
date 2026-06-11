#!/usr/bin/env node
/**
 * Evaluation runner for the golden dataset, parameterized for matrix sweeps.
 *
 * Usage:
 *   npm run eval                                          # defaults (chunk=800, top-k=8, rerank off, cache off)
 *   npm run eval -- --chunk-size 512 --top-k 5            # sweep cell
 *   npm run eval -- --rerank on --cache on                # toggles
 *   npm run eval -- --provider gemini --model <name>      # model override
 *   npm run eval -- --limit 10 --output reports/x.json    # quick run
 *
 * Each run loads evals/golden.jsonl, executes the full pipeline per question
 * (retrieve -> generate -> validate with retry), and writes:
 *   - the per-question report to --output (default reports/baseline.json)
 *   - a resumable progress file keyed by config (so an interrupted sweep cell
 *     resumes itself, but never picks up another cell's results)
 *   - an aggregated row appended to reports/study-raw.json for the study table
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { retrieve } from '../src/retrieval/retrieve.js';
import { trace, span, flush } from '../src/obs/langfuse.js';
import { RUNTIME, applyRuntimeOverrides, type Provider } from '../src/config/runtime.js';
import { getSystemPrompt, getUserMessage } from '../src/prompts/generation.js';
import { validateWithRetry } from '../src/validator/retry.js';
import { generateWithStructuredOutputSafe } from '../src/generate/langchain-generator.js';
import { resetUsage, getUsageTotals } from '../src/obs/usage.js';

interface Question {
  id: string;
  question: string;
  expected_citations: string[];
  category: 'factual_single_case' | 'cross_case_comparative' | 'adversarial_benign' | 'out_of_corpus';
  notes: string;
}

export interface EvalConfig {
  chunk_size: number;
  top_k: number;
  rerank: boolean;
  cache: boolean;
  provider: string;
  model: string;
  collection: string;
}

interface EvalResult {
  question_id: string;
  question: string;
  category: string;
  answer: string;
  retrieved_chunks: Array<{
    id: string | number;
    case_name: string;
    citation?: string;
    score: number;
    rerank_score?: number;
  }>;
  latency_ms: number;
  retrieval_dense_ms: number;
  retrieval_rerank_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  llm_calls: number;
  cost_usd: number;
  expected_citations: string[];
  citation_recall: number;
  retrieval_hit: boolean | null;
  retrieval_score_avg: number;
  abstained: boolean;
  validation_status: 'valid' | 'insufficient_evidence';
  coverage_passed: boolean;
  grounding_passed: boolean;
  retry_attempts: number;
  notes?: string;
}

interface EvalReport {
  timestamp: string;
  config: EvalConfig;
  metrics: Record<string, number>;
  results: EvalResult[];
}

/**
 * Per-million-token pricing by model-name substring (input / cached input / output).
 * Cached input tokens are billed at the provider's cache-hit discount.
 * Unknown models fall through to zero cost (flagged in the report).
 */
const PRICING: Array<{ match: RegExp; inPerM: number; cachedInPerM: number; outPerM: number }> = [
  { match: /gpt-5|gpt5/i, inPerM: 1.25, cachedInPerM: 0.125, outPerM: 10.0 },
  { match: /gpt-4o-mini/i, inPerM: 0.15, cachedInPerM: 0.075, outPerM: 0.6 },
  { match: /gpt-4o/i, inPerM: 2.5, cachedInPerM: 1.25, outPerM: 10.0 },
  { match: /flash-lite/i, inPerM: 0.1, cachedInPerM: 0.025, outPerM: 0.4 },
  { match: /flash/i, inPerM: 0.3, cachedInPerM: 0.075, outPerM: 2.5 },
  { match: /llama-3\.3-70b/i, inPerM: 0.59, cachedInPerM: 0.59, outPerM: 0.79 },
];

function calculateCost(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number {
  const p = PRICING.find((row) => row.match.test(model));
  if (!p) return 0;
  const freshIn = Math.max(0, inputTokens - cachedTokens);
  return (
    (freshIn * p.inPerM + cachedTokens * p.cachedInPerM + outputTokens * p.outPerM) / 1_000_000
  );
}

function extractCiteabilitySignal(answer: string, expectedCitations: string[]): number {
  const citations = expectedCitations.filter((c): c is string => !!c);

  if (citations.length === 0) {
    // Out-of-corpus: system should refuse or be cautious
    const refusalSignals = [
      'i don\'t know',
      'not in',
      'not found',
      'not available',
      'cannot find',
      'cannot answer',
      'do not contain',
      'unclear',
      'uncertain',
    ];
    const answerLower = answer.toLowerCase();
    return refusalSignals.some((signal) => answerLower.includes(signal)) ? 1 : 0;
  }

  let matches = 0;
  for (const citation of citations) {
    if (
      answer.includes(citation) ||
      answer.includes(citation.split(',')[0]!) ||
      answer.toLowerCase().includes(citation.toLowerCase())
    ) {
      matches++;
    }
  }

  return citations.length > 0 ? matches / citations.length : 0;
}

function isChunkRelevant(chunk: any, expectedCitations: string[]): boolean {
  if (expectedCitations.length === 0) return false;

  const caseName = chunk.payload.case_name || '';
  const citation = chunk.payload.citation || '';

  for (const exp of expectedCitations) {
    if (
      caseName.includes(exp.split(',')[0]!) ||
      citation.includes(exp.split(',')[0]!) ||
      exp.includes(caseName)
    ) {
      return true;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadGoldenDataset(filepath: string): Promise<Question[]> {
  const questions: Question[] = [];

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filepath),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (line.trim()) {
        try {
          questions.push(JSON.parse(line));
        } catch (err) {
          console.error(`Failed to parse line: ${line}`, err);
        }
      }
    });

    rl.on('close', () => resolve(questions));
    rl.on('error', reject);
  });
}

async function evalQuestion(question: Question): Promise<{ result: EvalResult; error?: Error }> {
  const startTime = Date.now();
  resetUsage();

  try {
    const response = await trace(
      `eval_question_${question.id}`,
      async (t) => {
        // Retrieve chunks (dense + optional rerank, per RUNTIME)
        const retrieval = await span(t, 'retrieve', async () => {
          return retrieve(question.question);
        });

        const systemPrompt = getSystemPrompt();
        const userMessage = getUserMessage(question.question, retrieval.chunks as any);

        const parsedAnswer = await span(t, 'generate', async () => {
          return await generateWithStructuredOutputSafe(systemPrompt, userMessage);
        });

        const validationResult = await span(t, 'validate', async () => {
          return await validateWithRetry(parsedAnswer, retrieval.chunks, question.question, 1, t);
        });

        return { retrieval, validationResult };
      },
      { question_id: question.id, category: question.category },
    );

    const latency = Date.now() - startTime;
    const usage = getUsageTotals();
    const cost = calculateCost(
      RUNTIME.modelName,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
    );

    const answerText = response.validationResult.answer?.answer_spans
      ?.map((s: any) => s.text)
      .join(' ') || '';

    // Recall matches against prose AND the structured citations: an answer
    // that cites the expected case without naming it in a span still counts.
    const citedText = (response.validationResult.answer?.citations || [])
      .map((c: any) => `${c.case_name} ${c.citation ?? ''}`)
      .join(' ');
    const citationRecall = extractCiteabilitySignal(
      `${answerText} ${citedText}`,
      question.expected_citations,
    );

    const chunks = response.retrieval.chunks;
    const retrievalHit = question.expected_citations.length > 0
      ? chunks.some((c) => isChunkRelevant(c, question.expected_citations))
      : null;
    const retrievalScoreAvg = chunks.length
      ? chunks.reduce((s, c) => s + c.score, 0) / chunks.length
      : 0;

    const result: EvalResult = {
      question_id: question.id,
      question: question.question,
      category: question.category,
      answer: answerText,
      retrieved_chunks: chunks.map((r: any) => ({
        id: r.id,
        case_name: r.payload.case_name || 'unknown',
        citation: r.payload.citation || undefined,
        score: r.score,
        rerank_score: r.rerank_score,
      })),
      latency_ms: latency,
      retrieval_dense_ms: response.retrieval.denseMs,
      retrieval_rerank_ms: response.retrieval.rerankMs,
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      cached_input_tokens: usage.cachedInputTokens,
      llm_calls: usage.calls,
      cost_usd: cost,
      expected_citations: question.expected_citations,
      citation_recall: citationRecall,
      retrieval_hit: retrievalHit,
      retrieval_score_avg: retrievalScoreAvg,
      abstained: question.category === 'out_of_corpus' && citationRecall === 1,
      validation_status: response.validationResult.status,
      coverage_passed: response.validationResult.coverage_verdict?.passed ?? false,
      grounding_passed: response.validationResult.grounding_verdict?.passed ?? false,
      retry_attempts: response.validationResult.retry_attempts,
      notes: question.notes,
    };

    return { result };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`Error evaluating question ${question.id}:`, error.message);
    return {
      result: {
        question_id: question.id,
        question: question.question,
        category: question.category,
        answer: `ERROR: ${error.message}`,
        retrieved_chunks: [],
        latency_ms: Date.now() - startTime,
        retrieval_dense_ms: 0,
        retrieval_rerank_ms: null,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
        llm_calls: 0,
        cost_usd: 0,
        expected_citations: question.expected_citations,
        citation_recall: 0,
        retrieval_hit: null,
        retrieval_score_avg: 0,
        abstained: false,
        validation_status: 'insufficient_evidence',
        coverage_passed: false,
        grounding_passed: false,
        retry_attempts: 0,
      },
      error,
    };
  }
}

interface CliArgs {
  chunkSize: number;
  topK: number;
  rerank: boolean;
  cache: boolean;
  provider: Provider | null;
  model: string | null;
  limit: number | null;
  outputPath: string | null;
  delayMs: number;
  dataset: string;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: CliArgs = {
    chunkSize: 800,
    topK: RUNTIME.topK,
    rerank: false,
    cache: false,
    provider: null,
    model: null,
    limit: null,
    outputPath: null,
    delayMs: 2000,
    dataset: 'evals/golden.jsonl',
  };

  const next = (i: number): string => {
    const v = args[i + 1];
    if (!v) throw new Error(`Missing value for ${args[i]}`);
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--chunk-size': parsed.chunkSize = parseInt(next(i), 10); i++; break;
      case '--top-k': parsed.topK = parseInt(next(i), 10); i++; break;
      case '--rerank': parsed.rerank = next(i) === 'on'; i++; break;
      case '--cache': parsed.cache = next(i) === 'on'; i++; break;
      case '--provider': parsed.provider = next(i) as Provider; i++; break;
      case '--model': parsed.model = next(i); i++; break;
      case '--limit': parsed.limit = parseInt(next(i), 10); i++; break;
      case '--output': parsed.outputPath = next(i); i++; break;
      case '--delay': parsed.delayMs = parseInt(next(i), 10); i++; break;
      case '--dataset': parsed.dataset = next(i); i++; break;
    }
  }
  return parsed;
}

/** Chunk-size sweeps live in their own collections; 800 is the original corpus. */
function collectionForChunkSize(chunkSize: number): string {
  return chunkSize === 800 ? 'scotus_opinions' : `scotus_opinions_${chunkSize}`;
}

function configKey(c: EvalConfig): string {
  return `chunk${c.chunk_size}-k${c.top_k}-rerank${c.rerank ? 'on' : 'off'}-cache${c.cache ? 'on' : 'off'}`;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.floor(sorted.length * p)] ?? sorted[sorted.length - 1] ?? 0;
}

async function main() {
  const cli = parseCliArgs();

  applyRuntimeOverrides({
    collectionName: collectionForChunkSize(cli.chunkSize),
    topK: cli.topK,
    rerank: cli.rerank,
    promptCache: cli.cache,
    ...(cli.provider ? { provider: cli.provider } : {}),
    ...(cli.model ? { modelName: cli.model } : {}),
  });

  const config: EvalConfig = {
    chunk_size: cli.chunkSize,
    top_k: cli.topK,
    rerank: cli.rerank,
    cache: cli.cache,
    provider: RUNTIME.provider,
    model: RUNTIME.modelName,
    collection: RUNTIME.collectionName,
  };
  const key = configKey(config);
  const outputPath = cli.outputPath ?? `reports/eval-${key}.json`;

  const reportsDir = path.dirname(outputPath);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Progress file is keyed by config: resuming one sweep cell must never
  // pick up another cell's partial results.
  const inProgressPath = path.join(reportsDir, `eval-in-progress-${key}.jsonl`);

  console.log(`Config: ${JSON.stringify(config)}`);
  console.log(`Loading dataset: ${cli.dataset}`);
  let questions = await loadGoldenDataset(cli.dataset);
  if (cli.limit) questions = questions.slice(0, cli.limit);
  console.log(`Loaded ${questions.length} questions`);

  // Resume support
  let startIndex = 0;
  const results: EvalResult[] = [];
  if (fs.existsSync(inProgressPath)) {
    const savedResults = fs
      .readFileSync(inProgressPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());
    startIndex = savedResults.length;
    console.log(`Resuming: ${startIndex} questions already completed for this config`);
    for (const line of savedResults) {
      try {
        results.push(JSON.parse(line));
      } catch {
        console.warn(`Failed to parse saved result line: ${line.substring(0, 50)}`);
      }
    }
  }

  const remaining = questions.length - startIndex;
  console.log(`Running ${remaining} questions (${cli.delayMs}ms between requests)...`);

  for (let i = startIndex; i < questions.length; i++) {
    const question = questions[i];
    if (!question) continue;
    console.log(`[${i + 1}/${questions.length}] ${question.id}: ${question.question.substring(0, 50)}...`);

    const { result, error } = await evalQuestion(question);
    results.push(result);

    if (error) {
      console.error(`  ERROR: ${error.message}`);
    } else {
      console.log(
        `  Latency: ${result.latency_ms}ms | Tokens: ${result.total_tokens} (cached ${result.cached_input_tokens}) | Cost: $${result.cost_usd.toFixed(5)} | Recall: ${(result.citation_recall * 100).toFixed(0)}%`,
      );
    }

    fs.appendFileSync(inProgressPath, JSON.stringify(result) + '\n');

    if (i < questions.length - 1) {
      await sleep(cli.delayMs);
    }
  }

  // Aggregate metrics
  const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const totalCost = results.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalTokens = results.reduce((sum, r) => sum + r.total_tokens, 0);
  const totalCached = results.reduce((sum, r) => sum + r.cached_input_tokens, 0);
  const totalPromptTokens = results.reduce((sum, r) => sum + r.prompt_tokens, 0);
  const avgCitationRecall = results.reduce((sum, r) => sum + r.citation_recall, 0) / results.length;

  const withExpected = results.filter((r) => r.retrieval_hit !== null);
  const retrievalAtK = withExpected.length
    ? withExpected.filter((r) => r.retrieval_hit).length / withExpected.length
    : 0;

  const outOfCorpus = results.filter((r) => r.category === 'out_of_corpus');
  const abstentionAccuracy = outOfCorpus.length
    ? outOfCorpus.filter((r) => r.abstained).length / outOfCorpus.length
    : 0;

  const rerankTimes = results
    .map((r) => r.retrieval_rerank_ms)
    .filter((v): v is number => v !== null);

  const metrics: Record<string, number> = {
    total_questions: results.length,
    retrieval_at_k: Number(retrievalAtK.toFixed(3)),
    citation_recall: Number(avgCitationRecall.toFixed(3)),
    abstention_accuracy: Number(abstentionAccuracy.toFixed(3)),
    coverage_pass_rate: Number((results.filter((r) => r.coverage_passed).length / results.length).toFixed(3)),
    grounding_pass_rate: Number((results.filter((r) => r.grounding_passed).length / results.length).toFixed(3)),
    validator_rejection_rate: Number(
      (results.filter((r) => r.validation_status === 'insufficient_evidence').length / results.length).toFixed(3),
    ),
    avg_retry_attempts: Number(
      (results.reduce((s, r) => s + r.retry_attempts, 0) / results.length).toFixed(2),
    ),
    avg_latency_ms: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0,
    p50_latency_ms: percentile(latencies, 0.5),
    p95_latency_ms: percentile(latencies, 0.95),
    avg_rerank_ms: rerankTimes.length
      ? Math.round(rerankTimes.reduce((a, b) => a + b, 0) / rerankTimes.length)
      : 0,
    retrieval_score_avg: Number(
      (results.reduce((s, r) => s + r.retrieval_score_avg, 0) / results.length).toFixed(3),
    ),
    total_cost_usd: Number(totalCost.toFixed(5)),
    cost_per_query_usd: Number((totalCost / results.length).toFixed(6)),
    total_tokens: totalTokens,
    prompt_tokens: totalPromptTokens,
    cached_input_tokens: totalCached,
    cache_hit_rate: totalPromptTokens ? Number((totalCached / totalPromptTokens).toFixed(3)) : 0,
    avg_tokens_per_query: results.length ? Math.round(totalTokens / results.length) : 0,
    avg_llm_calls_per_query: Number(
      (results.reduce((s, r) => s + r.llm_calls, 0) / results.length).toFixed(2),
    ),
  };

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    config,
    metrics,
    results,
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n✓ Report written to ${outputPath}`);

  // Append the aggregated row to study-raw.json (sweep summary table input).
  // Re-running a config replaces its previous row.
  const studyRawPath = path.join(reportsDir, 'study-raw.json');
  let studyRows: Array<{ key: string; timestamp: string; config: EvalConfig; metrics: Record<string, number> }> = [];
  if (fs.existsSync(studyRawPath)) {
    try {
      studyRows = JSON.parse(fs.readFileSync(studyRawPath, 'utf-8'));
    } catch {
      console.warn('study-raw.json unreadable; starting fresh');
    }
  }
  studyRows = studyRows.filter((row) => row.key !== key);
  studyRows.push({ key, timestamp: report.timestamp, config, metrics });
  fs.writeFileSync(studyRawPath, JSON.stringify(studyRows, null, 2));
  console.log(`✓ Summary row appended to ${studyRawPath} (key: ${key})`);

  // Print summary
  console.log('\n=== EVALUATION METRICS ===');
  console.log(`Config: ${key} | model: ${config.model}`);
  console.log(`Citation recall: ${(metrics.citation_recall! * 100).toFixed(1)}% | Retrieval@K: ${(metrics.retrieval_at_k! * 100).toFixed(1)}% | Abstention: ${(metrics.abstention_accuracy! * 100).toFixed(1)}%`);
  console.log(`Validator: coverage ${(metrics.coverage_pass_rate! * 100).toFixed(0)}% | grounding ${(metrics.grounding_pass_rate! * 100).toFixed(0)}% | rejection ${(metrics.validator_rejection_rate! * 100).toFixed(0)}%`);
  console.log(`Latency: p50 ${metrics.p50_latency_ms}ms | p95 ${metrics.p95_latency_ms}ms | rerank avg ${metrics.avg_rerank_ms}ms`);
  console.log(`Tokens: ${metrics.total_tokens} total | ${metrics.cached_input_tokens} cached (${(metrics.cache_hit_rate! * 100).toFixed(1)}% of prompt)`);
  console.log(`Cost: $${metrics.total_cost_usd} total | $${metrics.cost_per_query_usd}/query`);

  await flush();
  console.log('\nTraces flushed');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
