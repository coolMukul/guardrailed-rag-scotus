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
import { trace, span, flush } from '../../obs/langfuse.js';
import { guardrailInput } from '../../guardrails/pipeline.js';
import { createRequestLogger } from '../../logger.js';
import { isAppError } from '../../errors.js';
import { CONFIG } from '../../config/constants.js';
import { getSystemPrompt, getUserMessage } from '../../prompts/generation.js';
import { validateWithRetry } from '../../validator/retry.js';
import { generateWithStructuredOutputSafe } from '../../generate/langchain-generator.js';

// Type-safe request/response contracts
interface AskRequest {
  query: string;
}

interface AskResponse {
  answer_spans: Array<{text: string; citation_ids: number[]}>;
  citations: Array<{chunk_id: number; case_name: string; citation: string | null; section: string | null; text: string}>;
  validation_status: 'valid' | 'insufficient_evidence';
  retrieved_chunk_ids: (string | number)[]; // IDs of chunks used for context
  query: string; // Echo back the query
}

/**
 * Register the /ask POST endpoint on a Fastify app.
 *
 * Usage:
 *   POST /ask
 *   Body: { "query": "What did Miranda hold?" }
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

      // Extract and validate query
      const { query } = (request.body as AskRequest) || {};

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

      const startTime = Date.now();

      try {
        // Wrap the entire request — guardrails included — in a single trace,
        // so blocked requests are observable too (each guardrail layer gets
        // its own span inside guardrailInput).
        const result = await trace('ask', async (t) => {
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
          const retrieved = await span(t, 'retrieve', async () => {
            reqLogger.debug({ action: 'retrieve_start', queryLength: safeQuery.length });
            const outcome = await retrieve(safeQuery);
            reqLogger.info({
              action: 'retrieve_complete',
              chunkCount: outcome.chunks.length,
              denseMs: outcome.denseMs,
              rerankMs: outcome.rerankMs,
            });
            return outcome.chunks;
          });

          // Get chunk IDs for return value
          const chunkIds = retrieved.map((r) => r.id);

          // Span 2: Generate answer with citation structure
          // Generate with guaranteed structured output via LangChain
          const systemPrompt = getSystemPrompt();
          const userMessage = getUserMessage(safeQuery, retrieved);

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

          // Validate with retry logic; the trace gives the grounding judge
          // and any regeneration their own spans
          const validationResult = await span(t, 'validate', async () => {
            return await validateWithRetry(parsedAnswer, retrieved, safeQuery, 1, t);
          });

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
          };
        });

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
