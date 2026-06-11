/**
 * Zod schema for structured answer generation with citations.
 *
 * All answers must follow this schema:
 * - answer_spans: list of text segments, each with citation IDs pointing to retrieved chunks
 * - citations: full text of cited chunks (for context in validator and client)
 *
 * This enforces structure at the boundary — if generation output doesn't match,
 * we regenerate rather than trying to patch invalid JSON.
 */

import { z } from 'zod';

// Single citation reference within answer text
export const AnswerSpanSchema = z.object({
  text: z.string().min(1, 'Span text cannot be empty'),
  citation_ids: z.array(z.number().int().nonnegative()).nonempty('Each span must cite at least one chunk'),
});

export type AnswerSpan = z.infer<typeof AnswerSpanSchema>;

// Full citation with chunk text
// Note: `citation`/`section` are `.nullable()` rather than `.optional()` because
// OpenAI/Azure strict structured outputs require EVERY property to be listed in
// `required`. Optional fields are dropped from `required` and rejected; nullable
// fields stay required but may be null.
export const CitationSchema = z.object({
  chunk_id: z.number().int().nonnegative(),
  case_name: z.string().min(1),
  citation: z.string().nullable(),
  section: z.string().nullable(),
  text: z.string().min(1, 'Citation text cannot be empty'),
});

export type Citation = z.infer<typeof CitationSchema>;

// Full answer structure: spans + full citation texts
export const AnswerSchema = z.object({
  answer_spans: z.array(AnswerSpanSchema).nonempty('Answer must have at least one span'),
  citations: z.array(CitationSchema),
});

export type Answer = z.infer<typeof AnswerSchema>;

/**
 * Parse and validate raw JSON as an Answer.
 * Throws if validation fails.
 *
 * Usage:
 *   const answer = parseAnswer(JSON.parse(genResponse))
 */
export function parseAnswer(data: unknown): Answer {
  return AnswerSchema.parse(data);
}

/**
 * Safely parse Answer, returning null on failure.
 * Useful for error handling in retry loops.
 */
export function tryParseAnswer(data: unknown): Answer | null {
  try {
    return parseAnswer(data);
  } catch {
    return null;
  }
}
