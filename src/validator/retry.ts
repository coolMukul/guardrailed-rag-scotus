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
      // Max retries reached; return insufficient_evidence
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
