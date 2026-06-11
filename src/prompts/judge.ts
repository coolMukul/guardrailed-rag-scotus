/**
 * Prompts for the LLM-as-judge grounding validator.
 *
 * Lives in src/prompts/ with the other LLM-facing strings so every prompt in
 * the system is auditable in one directory.
 */

import { Answer } from '../generate/schema.js';

export const JUDGE_SYSTEM =
  'You are a strict semantic judge. "Entails" means the cited chunk logically supports the claim. ' +
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
