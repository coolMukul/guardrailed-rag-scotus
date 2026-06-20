/**
 * POST /ask endpoint — orchestrates the RAG pipeline.
 *
 * Request flow:
 * 1. Validate user query (non-empty, reasonable length)
 * 2. Retrieve similar chunks from Qdrant
 * 3. Generate answer via Groq using retrieved context
 * 4. Log to Langfuse (trace + spans)
 * 5. Return answer + chunk IDs
 *
 * Error handling:
 * - Validates input at boundary (400)
 * - Catches service errors (Qdrant, Groq) with specific HTTP codes
 * - Logs full context for debugging
 * - Returns structured error responses
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { retrieve } from '../../retrieval/retrieve.js';
import type { SearchResult } from '../../retrieval/qdrant-client.js';
import { trace, span, flush } from '../../obs/langfuse.js';
import { guardrailInput } from '../../guardrails/pipeline.js';
import { createRequestLogger } from '../../logger.js';
import { isAppError } from '../../errors.js';
import { CONFIG } from '../../config/constants.js';
import { RUNTIME } from '../../config/runtime.js';
import { computeConfigFingerprint } from '../../config/fingerprint.js';
import { getSystemPrompt, getUserMessage } from '../../prompts/generation.js';
import { validateWithRetry } from '../../validator/retry.js';
import { checkCorpusScope } from '../../validator/corpus-scope.js';
import { generateWithStructuredOutputSafe } from '../../generate/langchain-generator.js';
import { withUsageScope, type UsageRecord } from '../../obs/usage.js';

// Type-safe request/response contracts
interface AskRequest {
  query: string;
  /** Opt-in: when true, the response carries a `diagnostics` block (eval harness contract). */
  include_diagnostics?: boolean;
}

// Diagnostics contract for the eval harness. Opt-in via include_diagnostics;
// when the flag is absent the response is byte-for-byte what it was before
// this block existed. Chunk text is deliberately excluded (payload bloat).
interface Diagnostics {
  retrieved_chunks: Array<{
    rank: number; // explicit, 1-based, final retrieval order (post-rerank when on)
    id: string | number;
    score: number;
    case_name: string;
    citation: string | null;
    section: string | null;
  }>;
  timings_ms: {
    retrieve_dense: number;
    retrieve_rerank: number | null; // null when reranking is disabled
    generate: number;
    validate: number;
    total: number;
  };
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    judge_prompt_tokens: number;
    judge_completion_tokens: number;
    guardrail_prompt_tokens: number;
    guardrail_completion_tokens: number;
  };
  retry_attempts: number;
  config_fingerprint: string;
  // Validation trace: lets the harness see WHY a query abstained — generator
  // abstention vs coverage failure vs which span the grounding judge rejected —
  // instead of only the final status. grounding_ran is false when the abstention
  // or coverage gate short-circuited before the judge was called.
  validation: {
    abstained: boolean;
    // Why the query abstained, or null when it answered. One of:
    // 'out_of_corpus' (named case absent), 'generator' (model declined),
    // 'coverage' (citation-structure failure), 'grounding' (judge rejected).
    abstain_reason: string | null;
    coverage_passed: boolean | null;
    coverage_issues: string[];
    grounding_ran: boolean;
    grounding_passed: boolean | null;
    grounding_issues: Array<{
      span_index: number;
      text: string;
      entails: boolean;
      reason: string;
    }>;
  };
}

interface AskResponse {
  answer_spans: Array<{text: string; citation_ids: number[]}>;
  citations: Array<{chunk_id: number; case_name: string; citation: string | null; section: string | null; text: string}>;
  validation_status: 'valid' | 'insufficient_evidence';
  retrieved_chunk_ids: (string | number)[]; // IDs of chunks used for context
  query: string; // Echo back the query
  diagnostics?: Diagnostics;
}

// Per-layer cost attribution (eval-team contract): 'generate' covers both the
// first attempt and validator-triggered regenerations (same call path, counted
// via retry_attempts); 'injection' is the guardrail classifier; anything else
// (today only the grounding judge) lands in judge_* so a new source can never
// silently vanish from cost-per-query totals.
function usageFromRecords(records: UsageRecord[]): Diagnostics['usage'] {
  const usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    judge_prompt_tokens: 0,
    judge_completion_tokens: 0,
    guardrail_prompt_tokens: 0,
    guardrail_completion_tokens: 0,
  };
  for (const r of records) {
    if (r.source === 'generate') {
      usage.prompt_tokens += r.inputTokens;
      usage.completion_tokens += r.outputTokens;
    } else if (r.source === 'injection') {
      usage.guardrail_prompt_tokens += r.inputTokens;
      usage.guardrail_completion_tokens += r.outputTokens;
    } else {
      usage.judge_prompt_tokens += r.inputTokens;
      usage.judge_completion_tokens += r.outputTokens;
    }
  }
  return usage;
}

// Classify why a validated answer ended up as an abstention, for diagnostics.
// 'out_of_corpus' is set directly by the corpus-scope guard, which short-circuits
// before this path runs, so it isn't produced here.
function deriveAbstainReason(v: {
  status: 'valid' | 'insufficient_evidence';
  answer?: { abstained?: boolean } | null;
  coverage_verdict?: { passed: boolean } | null;
}): string | null {
  if (v.status === 'valid') return null;
  if (v.answer?.abstained) return 'generator';
  if (v.coverage_verdict && !v.coverage_verdict.passed) return 'coverage';
  return 'grounding';
}

/**
 * Register the /ask POST endpoint on a Fastify app.
 *
 * Usage:
 *   POST /ask
 *   Body: { "query": "What did Miranda hold?" }
 *   Body (eval harness): { "query": "...", "include_diagnostics": true }
 *     — adds a `diagnostics` object (retrieved chunk metadata, stage timings,
 *       token usage, retry count, config fingerprint) to the 200 response.
 *       Without the flag the response is unchanged from the original contract.
 *
 * Response 200:
 *   {
 *     "answer_spans": [{"text": "...", "citation_ids": [0, 1]}],
 *     "citations": [{"chunk_id": 0, "case_name": "...", "citation": "...", "text": "..."}],
 *     "validation_status": "valid" | "insufficient_evidence",
 *     "retrieved_chunk_ids": [...],
 *     "query": "..."
 *   }
 *
 * Response 400 (invalid query):
 *   { "error": "...", "code": "VALIDATION_ERROR" }
 *
 * Response 429 (rate limited):
 *   { "error": "Groq rate limited", "code": "GROQ_RATE_LIMITED" }
 *
 * Response 503 (Qdrant/Groq down):
 *   { "error": "...", "code": "..._UNAVAILABLE" }
 */
export async function registerAskRoute(app: FastifyInstance) {
  app.post<{ Body: AskRequest }>(
    '/ask',
    async (request: FastifyRequest<{ Body: AskRequest }>, reply: FastifyReply) => {
      // Create a logger with this request's ID for tracing through logs
      const reqLogger = createRequestLogger(request.id);
      reqLogger.info({ action: 'ask_start' });

      // Wall-clock start for the whole request — diagnostics.timings_ms.total
      // is defined as server-side request time, so capture before validation.
      const startTime = Date.now();

      // Extract and validate query
      const { query, include_diagnostics } = (request.body as AskRequest) || {};
      const includeDiagnostics = include_diagnostics === true;

      // Input validation: reject empty or too-long queries early
      if (!query || typeof query !== 'string') {
        reqLogger.warn({
          action: 'ask_invalid_input',
          reason: 'query is not a string',
          queryType: typeof query,
        });
        return reply.status(400).send({
          error: 'Query must be a non-empty string',
          code: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString(),
        });
      }

      const trimmedQuery = query.trim();

      if (trimmedQuery.length === 0) {
        reqLogger.warn({ action: 'ask_empty_query' });
        return reply.status(400).send({
          error: 'Query cannot be empty',
          code: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString(),
        });
      }

      if (trimmedQuery.length > CONFIG.validation.maxQueryLength) {
        reqLogger.warn({
          action: 'ask_query_too_long',
          length: trimmedQuery.length,
          max: CONFIG.validation.maxQueryLength,
        });
        return reply.status(413).send({
          error: `Query exceeds ${CONFIG.validation.maxQueryLength} characters`,
          code: 'PAYLOAD_TOO_LARGE',
          timestamp: new Date().toISOString(),
        });
      }

      try {
        // Wrap the entire request — guardrails included — in a single trace,
        // so blocked requests are observable too (each guardrail layer gets
        // its own span inside guardrailInput). The usage scope captures token
        // counts from every LLM call made inside this request's async tree,
        // isolated from concurrent requests.
        const { result, records: usageRecords } = await withUsageScope(() => trace('ask', async (t) => {
          const guardrailResult = await guardrailInput(trimmedQuery, t);

          if (!guardrailResult.passed) {
            reqLogger.warn({
              action: 'ask_guardrail_violation',
              reason: guardrailResult.reason,
              verdicts: {
                pii_redacted: guardrailResult.verdicts.pii.redacted,
                injection_safe: guardrailResult.verdicts.injection.safe,
                policy_ok: guardrailResult.verdicts.policy.ok,
              },
            });
            return { blocked: true as const, reason: guardrailResult.reason };
          }

          // Use the (potentially PII-redacted) query for the pipeline
          const safeQuery = guardrailResult.redacted_query;

          // Span 1: Retrieve chunks (dense + optional rerank per RUNTIME)
          // Return the full outcome (not just chunks): denseMs/rerankMs feed
          // the diagnostics block.
          const retrieval = await span(t, 'retrieve', async () => {
            reqLogger.debug({ action: 'retrieve_start', queryLength: safeQuery.length });
            const outcome = await retrieve(safeQuery);
            reqLogger.info({
              action: 'retrieve_complete',
              chunkCount: outcome.chunks.length,
              denseMs: outcome.denseMs,
              rerankMs: outcome.rerankMs,
            });
            return outcome;
          });
          const retrieved = retrieval.chunks;

          // Get chunk IDs for return value
          const chunkIds = retrieved.map((r) => r.id);

          // Corpus-scope guard (strict out-of-corpus contract): if the question
          // names a specific case whose own opinion isn't in the retrieved set,
          // abstain deterministically — before spending generate/judge calls —
          // rather than letting the model reconstruct the holding from a related
          // in-corpus opinion (which prompt-only enforcement leaked on).
          if (RUNTIME.corpusScopeGuard) {
            const scope = checkCorpusScope(safeQuery, retrieved);
            if (scope.outOfCorpus) {
              reqLogger.info({ action: 'corpus_scope_abstain', namedCase: scope.namedCase });
              const top = retrieved[0];
              return {
                blocked: false as const,
                answer_spans: [
                  {
                    text: `The provided excerpts do not include the opinion in ${scope.namedCase}, so I cannot answer that from the available material.`,
                    citation_ids: top ? [Number(top.id)] : [],
                  },
                ],
                citations: top
                  ? [
                      {
                        chunk_id: Number(top.id),
                        case_name: top.payload.case_name,
                        citation: top.payload.citation ?? null,
                        section: top.payload.section ?? null,
                        text: top.payload.text,
                      },
                    ]
                  : [],
                validation_status: 'insufficient_evidence' as const,
                retrieved_chunk_ids: chunkIds,
                query: safeQuery,
                retrieved_chunks: retrieved as SearchResult[],
                dense_ms: retrieval.denseMs,
                rerank_ms: retrieval.rerankMs,
                generate_ms: 0,
                validate_ms: 0,
                retry_attempts: 0,
                abstained: true,
                abstain_reason: 'out_of_corpus' as string | null,
                coverage_verdict: { passed: false, issues: [`out_of_corpus: ${scope.namedCase}`] } as {
                  passed: boolean;
                  issues: string[];
                } | null,
                grounding_verdict: null as {
                  passed: boolean;
                  issues: Array<{ spanIndex: number; text: string; entails: boolean; reason: string }>;
                } | null,
              };
            }
          }

          // Span 2: Generate answer with citation structure
          // Generate with guaranteed structured output via LangChain
          const systemPrompt = getSystemPrompt();
          const userMessage = getUserMessage(safeQuery, retrieved);

          const generateStart = Date.now();
          const parsedAnswer = await span(t, 'generate', async () => {
            reqLogger.debug({ action: 'generate_start' });

            try {
              // No explicit model: defaults to RUNTIME.modelName so runtime
              // overrides (sweeps, provider switches) apply uniformly.
              const answer = await generateWithStructuredOutputSafe(systemPrompt, userMessage);

              if (answer) {
                reqLogger.info({ action: 'generate_success' });
              } else {
                reqLogger.warn({ action: 'generate_structured_output_failed' });
              }

              return answer;
            } catch (err) {
              reqLogger.error({
                action: 'generate_failed',
                error: err instanceof Error ? err.message : String(err),
              });
              return null;
            }
          });

          const generateMs = Date.now() - generateStart;

          // Validate with retry logic; the trace gives the grounding judge
          // and any regeneration their own spans
          const validateStart = Date.now();
          const validationResult = await span(t, 'validate', async () => {
            return await validateWithRetry(parsedAnswer, retrieved, safeQuery, RUNTIME.validatorRetries, t);
          });
          const validateMs = Date.now() - validateStart;

          // Log validation metrics
          if (t) {
            const coveragePass = validationResult.coverage_verdict?.passed ?? false;
            const groundingPass = validationResult.grounding_verdict?.passed ?? false;
            t.span({
              name: 'validation_verdict',
              metadata: {
                coverage_passed: coveragePass,
                grounding_passed: groundingPass,
                retry_attempts: validationResult.retry_attempts,
                final_status: validationResult.status,
              },
            }).end();
          }

          reqLogger.info({
            action: 'validation_complete',
            status: validationResult.status,
            retries: validationResult.retry_attempts,
          });

          return {
            blocked: false as const,
            answer_spans: validationResult.answer?.answer_spans || [],
            citations: validationResult.answer?.citations || [],
            validation_status: validationResult.status,
            retrieved_chunk_ids: chunkIds,
            query: safeQuery,
            // Diagnostics inputs (serialized only when include_diagnostics is set)
            retrieved_chunks: retrieved as SearchResult[],
            dense_ms: retrieval.denseMs,
            rerank_ms: retrieval.rerankMs,
            generate_ms: generateMs,
            validate_ms: validateMs,
            retry_attempts: validationResult.retry_attempts,
            abstained: validationResult.answer?.abstained ?? false,
            abstain_reason: deriveAbstainReason(validationResult),
            coverage_verdict: validationResult.coverage_verdict ?? null,
            grounding_verdict: validationResult.grounding_verdict ?? null,
          };
        }));

        // Flush Langfuse traces (non-blocking, but should complete soon)
        // This ensures traces are sent to Langfuse before response is returned
        await flush();

        if (result.blocked) {
          return reply.status(400).send({
            error: `Request blocked by guardrails: ${result.reason}`,
            code: 'GUARDRAIL_VIOLATION',
            timestamp: new Date().toISOString(),
          });
        }

        const elapsed = Date.now() - startTime;
        const answerText = result.answer_spans.map((s) => s.text).join(' ');
        reqLogger.info({
          action: 'ask_complete',
          elapsed,
          answerLength: answerText.length,
          retrievedCount: result.retrieved_chunk_ids.length,
        });

        // Return structured answer with citations and validation status
        const response: AskResponse = {
          answer_spans: result.answer_spans,
          citations: result.citations,
          validation_status: result.validation_status,
          retrieved_chunk_ids: result.retrieved_chunk_ids,
          query: result.query,
        };

        // Opt-in diagnostics for the eval harness. When the flag is absent
        // the field is never set, keeping the response identical to the
        // pre-diagnostics contract.
        if (includeDiagnostics) {
          response.diagnostics = {
            retrieved_chunks: result.retrieved_chunks.map((c, i) => ({
              rank: i + 1,
              id: c.id,
              score: c.score,
              case_name: c.payload.case_name,
              citation: c.payload.citation ?? null,
              section: c.payload.section ?? null,
            })),
            timings_ms: {
              retrieve_dense: result.dense_ms,
              retrieve_rerank: result.rerank_ms,
              generate: result.generate_ms,
              validate: result.validate_ms,
              total: Date.now() - startTime,
            },
            usage: usageFromRecords(usageRecords),
            retry_attempts: result.retry_attempts,
            config_fingerprint: computeConfigFingerprint(),
            validation: {
              abstained: result.abstained,
              abstain_reason: result.abstain_reason,
              coverage_passed: result.coverage_verdict?.passed ?? null,
              coverage_issues: result.coverage_verdict?.issues ?? [],
              grounding_ran: result.grounding_verdict != null,
              grounding_passed: result.grounding_verdict?.passed ?? null,
              grounding_issues: (result.grounding_verdict?.issues ?? []).map((iss) => ({
                span_index: iss.spanIndex,
                text: iss.text,
                entails: iss.entails,
                reason: iss.reason,
              })),
            },
          };
        }

        return reply.send(response);
      } catch (err) {
        const elapsed = Date.now() - startTime;

        // Check error type and map to appropriate HTTP response
        if (isAppError(err)) {
          // Application error: has specific code and status
          reqLogger.warn({
            action: 'ask_app_error',
            code: err.code,
            message: err.message,
            status: err.status,
            elapsed,
          });

          return reply.status(err.status).send({
            error: err.message,
            code: err.code,
            details: err.details,
            timestamp: new Date().toISOString(),
          });
        }

        // Unknown error: treat as 500 Internal Server Error
        // Log full stack for debugging
        reqLogger.error({
          action: 'ask_unknown_error',
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          elapsed,
        });

        return reply.status(500).send({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR',
          timestamp: new Date().toISOString(),
        });
      }
    },
  );
}
