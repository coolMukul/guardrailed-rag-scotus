/**
 * Prompts for the LLM-as-judge grounding validator.
 *
 * Lives in src/prompts/ with the other LLM-facing strings so every prompt in
 * the system is auditable in one directory.
 */

import { Answer } from '../generate/schema.js';

/**
 * Version of the grounding-judge prompt. Folded into the config fingerprint so
 * a change to judge wording (which shifts the abstention rate, a scored eval
 * metric) invalidates cross-run comparisons rather than silently drifting.
 */
export const JUDGE_VERSION = 'grounding-judge-v2';

// Calibrated, not maximally strict: an over-strict judge rejected claims the
// cited chunk genuinely supported (paraphrase or a direct inference), then the
// single retry couldn't recover and the pipeline abstained on answerable,
// in-corpus questions. The standard here is "does the chunk support the claim,"
// allowing faithful paraphrase and direct inference — NOT "does the chunk
// restate the claim verbatim." Fabrication and contradiction still fail.
export const JUDGE_SYSTEM =
  'You are a careful, fair grounding judge. A claim "entails" when the cited chunk supports it — ' +
  'this includes faithful paraphrase and direct inferences a careful reader would draw from the chunk. ' +
  'Do not require verbatim wording or that the chunk restate the claim. ' +
  'Mark entails=false only when the chunk does not support the claim or contradicts it. ' +
  'Judge each span independently and report a verdict for every span.';

/**
 * Build the per-span judging prompt.
 */
export function buildJudgePrompt(
  answer: Answer,
  chunkMap: Map<number, { text: string }>,
): string {
  let prompt =
    'For each claim below, decide whether the cited chunk(s) actually entail (support) the claim.\n\n';

  for (let i = 0; i < answer.answer_spans.length; i++) {
    const span = answer.answer_spans[i];
    if (!span) continue;
    prompt += `\n[Span ${i}] Claim: "${span.text}"\n`;

    if (span.citation_ids && span.citation_ids.length > 0) {
      for (const cid of span.citation_ids) {
        const chunk = chunkMap.get(cid);
        if (chunk) {
          // Show enough of the chunk to judge fairly: at 300 chars the judge
          // rejected claims supported later in the chunk (fail rate ~60%+).
          prompt += `Cited Chunk [${cid}]: "${chunk.text.substring(0, 1800)}"\n`;
        }
      }
    }
  }

  return prompt;
}
