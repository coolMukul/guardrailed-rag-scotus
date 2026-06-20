/**
 * Retry loop with bounded retries.
 *
 * Flow:
 * 1. Attempt: validate coverage → if fail, return with status 'insufficient_evidence'
 * 2. Attempt: validate grounding → if fail and retries > 0, regenerate with feedback
 * 3. Final: return with status 'valid' or 'insufficient_evidence'
 *
 * Why bounded retries?
 * - Without bounds: infinite loop on hard questions
 * - With bounds: try once more with feedback, then abstain
 * - Practical: most regenerations succeed if given feedback; second attempt usually sufficient
 */

import { Answer } from '../generate/schema.js';
import { validateCoverageDeterministic } from './citation-coverage.js';
import { validateGroundingWithLLM } from './grounding-judge.js';
import { getRegenerationPrompt, getSystemPrompt } from '../prompts/generation.js';
import { span } from '../obs/langfuse.js';
import { logger } from '../logger.js';
import { generateWithStructuredOutputSafe } from '../generate/langchain-generator.js';
import { RUNTIME } from '../config/runtime.js';

export type ValidationStatus = 'valid' | 'insufficient_evidence';

export interface FinalAnswer {
  answer: Answer;
  status: ValidationStatus;
  coverage_verdict?: {passed: boolean; issues: string[]};
  grounding_verdict?: {passed: boolean; issues: Array<{spanIndex: number; text: string; entails: boolean; reason: string}>};
  retry_attempts: number;
}

/**
 * Validate answer with bounded retry.
 * Attempts up to maxRetries regenerations if grounding check fails.
 *
 * @param trace Optional observability trace; when provided, the grounding
 *              judge and each regeneration get their own spans.
 */
export async function validateWithRetry(
  initialAnswer: Answer | null, // Can be null if initial generation had parse errors
  retrievedChunks: Array<{id: string | number; payload: any}>,
  query: string,
  maxRetries: number = 1,
  trace?: unknown,
): Promise<FinalAnswer> {
  const t = trace ?? null;
  let answer = initialAnswer;
  let attempt = 0;
  let coverageVerdictFinal: any = null;
  let groundingVerdictFinal: any = null;

  // If initial answer is null (generation error), try to regenerate once
  if (!answer && maxRetries > 0) {
    logger.warn({
      action: 'validate_initial_generation_failed',
      maxRetries,
    });

    answer = await span(t, 'regenerate', () => regenerateAnswer(retrievedChunks, query, []));
    attempt++;

    if (!answer) {
      // Still can't generate after retry
      return {
        answer: answer as any,
        status: 'insufficient_evidence',
        coverage_verdict: {passed: false, issues: ['Failed to generate valid answer']},
        retry_attempts: attempt,
      };
    }
  }

  // If we still don't have a valid answer, fail immediately
  if (!answer) {
    return {
      answer: answer as any,
      status: 'insufficient_evidence',
      coverage_verdict: {passed: false, issues: ['No valid answer provided']},
      retry_attempts: attempt,
    };
  }

  // Main retry loop
  while (attempt <= maxRetries) {
    // Gate 0: Explicit abstention. When the generator declines (question not
    // answerable from the excerpts, or names an out-of-corpus case), it sets
    // answer.abstained. That is the contract signal — report it as
    // insufficient_evidence directly. Without this the refusal text would sail
    // through the citation gates (it cites the most relevant chunk) and be
    // mislabeled 'valid'. Skipping the grounding judge here also saves an LLM
    // call on a deliberate non-answer.
    if (answer.abstained) {
      logger.info({ action: 'validate_generator_abstained', attempt });
      return {
        answer,
        status: 'insufficient_evidence',
        coverage_verdict: { passed: false, issues: ['Generator abstained: question not answerable from corpus'] },
        retry_attempts: attempt,
      };
    }

    // Gate 1: Coverage check (deterministic, fast)
    const coverage = validateCoverageDeterministic(answer, retrievedChunks);
    coverageVerdictFinal = coverage;

    if (!coverage.passed) {
      logger.info({
        action: 'validate_coverage_failed',
        attempt,
        issues: coverage.issues,
      });
      return {
        answer,
        status: 'insufficient_evidence',
        coverage_verdict: coverage,
        retry_attempts: attempt,
      };
    }

    // Gate 2: Grounding check (LLM, expensive but semantic)
    const grounding = await span(t, 'grounding_judge', () =>
      validateGroundingWithLLM(answer!, retrievedChunks),
    );
    groundingVerdictFinal = grounding;

    if (grounding.passed) {
      // Success!
      logger.info({
        action: 'validate_success',
        attempt,
      });
      return {
        answer,
        status: 'valid',
        coverage_verdict: coverage,
        grounding_verdict: grounding,
        retry_attempts: attempt,
      };
    }

    // Gate 2 failed; decide whether to retry
    if (attempt < maxRetries) {
      logger.info({
        action: 'validate_grounding_failed_retrying',
        attempt,
        issues: grounding.issues.length,
      });

      // Regenerate with corrective feedback (structured output returns a parsed Answer directly)
      const regenerated = await span(t, 'regenerate', () =>
        regenerateAnswer(retrievedChunks, query, grounding.issues),
      );

      if (!regenerated) {
        logger.warn({
          action: 'validate_regeneration_failed',
          attempt,
        });
        return {
          answer,
          status: 'insufficient_evidence',
          coverage_verdict: coverage,
          grounding_verdict: grounding,
          retry_attempts: attempt + 1,
        };
      }

      answer = regenerated;
      attempt++;
    } else {
      // Max retries reached and grounding still has unsupported spans.
      // Per-span salvage: rather than throwing away a good answer because one
      // secondary span failed, keep the spans the judge DID support and drop
      // only the unsupported ones. Abstain only when no span survives. This is
      // the fix for over-abstention where retrieval HIT and the core holding is
      // grounded but a secondary detail (standing, a procedural step) is not.
      if (RUNTIME.groundingMode === 'per_span') {
        const salvaged = salvageSupportedSpans(answer, grounding);
        if (salvaged) {
          logger.info({
            action: 'validate_grounding_salvaged',
            attempt,
            kept: salvaged.answer_spans.length,
            dropped: answer.answer_spans.length - salvaged.answer_spans.length,
          });
          return {
            answer: salvaged,
            status: 'valid',
            coverage_verdict: coverage,
            grounding_verdict: grounding,
            retry_attempts: attempt,
          };
        }
        // salvaged === null: every span was unsupported -> genuine abstention.
      }

      logger.info({
        action: 'validate_max_retries_reached',
        attempt,
      });
      return {
        answer,
        status: 'insufficient_evidence',
        coverage_verdict: coverage,
        grounding_verdict: grounding,
        retry_attempts: attempt,
      };
    }
  }

  // Fallback (shouldn't reach here)
  return {
    answer,
    status: 'insufficient_evidence',
    coverage_verdict: coverageVerdictFinal,
    grounding_verdict: groundingVerdictFinal,
    retry_attempts: attempt,
  };
}

/**
 * Keep only the spans the grounding judge supported, dropping the unsupported
 * ones, and prune the citations array to chunks the surviving spans still cite.
 *
 * Returns null when no span survives (every span was unsupported) — the caller
 * treats that as a genuine abstention. Returns the original answer unchanged if
 * nothing would be dropped (defensive; the caller only invokes this when
 * grounding failed, so at least one span is unsupported).
 */
function salvageSupportedSpans(
  answer: Answer,
  grounding: { issues: Array<{ spanIndex: number }> },
): Answer | null {
  const failed = new Set(grounding.issues.map((iss) => iss.spanIndex));
  const kept = answer.answer_spans.filter((_, i) => !failed.has(i));

  if (kept.length === 0) return null;
  if (kept.length === answer.answer_spans.length) return answer;

  const usedIds = new Set<number>();
  for (const s of kept) {
    for (const id of s.citation_ids) usedIds.add(id);
  }
  const citations = answer.citations.filter((c) => usedIds.has(c.chunk_id));

  return {
    ...answer,
    answer_spans: kept as Answer['answer_spans'],
    citations,
  };
}

/**
 * Regenerate answer with corrective feedback from grounding check.
 * Returns parsed Answer directly via LangChain structured output.
 */
async function regenerateAnswer(
  retrievedChunks: Array<{id: string | number; payload: any}>,
  query: string,
  groundingIssues: Array<{spanIndex: number; text: string; entails: boolean; reason: string}>,
): Promise<Answer | null> {
  const systemPrompt = getSystemPrompt();
  const regenerationPrompt = getRegenerationPrompt(query, retrievedChunks, groundingIssues);

  // No explicit model: defaults to RUNTIME.modelName so sweep overrides apply
  // to regeneration too (an explicit CONFIG value here once sent retries to
  // the wrong provider).
  return await generateWithStructuredOutputSafe(systemPrompt, regenerationPrompt);
}
