/**
 * Deterministic citation coverage validator.
 *
 * Checks that:
 * 1. Every span has at least one citation
 * 2. Every citation ID references a chunk that was actually retrieved
 *
 * This is fast (O(n) set membership) and catches structural failures early.
 * Runs before the expensive LLM grounding check.
 */

import { Answer } from '../generate/schema.js';

export interface CoverageVerdictDeterministic {
  passed: boolean;
  issues: string[];
  coverage_rate?: number; // For metrics: % of spans that are cited
}

/**
 * Validate that all cited chunks were actually retrieved.
 * Does not check semantic correctness — only structural validity.
 */
export function validateCoverageDeterministic(
  answer: Answer,
  retrievedChunks: Array<{id: string | number; payload: any}>,
): CoverageVerdictDeterministic {
  const issues: string[] = [];
  const retrievedIds = new Set(retrievedChunks.map((c) => Number(c.id)));

  // Check 1: Every span must have citations
  for (let i = 0; i < answer.answer_spans.length; i++) {
    const span = answer.answer_spans[i];
    if (!span) continue;

    if (!span.citation_ids || span.citation_ids.length === 0) {
      issues.push(`Span ${i}: "${span.text.substring(0, 50)}..." has no citations`);
    }

    // Check 2: Every citation must reference a retrieved chunk
    if (span.citation_ids) {
      for (const citId of span.citation_ids) {
        if (!retrievedIds.has(citId)) {
          issues.push(`Span ${i}: Citation ID ${citId} was not retrieved (available: ${Array.from(retrievedIds).join(', ')})`);
        }
      }
    }
  }

  // Calculate coverage rate: spans with valid citations / total spans
  const validSpans = answer.answer_spans.filter(
    (span) => span.citation_ids && span.citation_ids.length > 0 && span.citation_ids.every((id) => retrievedIds.has(id)),
  );

  const coverage_rate = answer.answer_spans.length > 0 ? validSpans.length / answer.answer_spans.length : 0;

  return {
    passed: issues.length === 0,
    issues,
    coverage_rate,
  };
}
