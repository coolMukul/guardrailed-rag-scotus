/**
 * LLM-as-judge grounding validator.
 *
 * For each span in the answer, ask an LLM to verify:
 * "Does the cited chunk actually entail (support) this claim?"
 *
 * This is expensive (one LLM call per answer) but catches semantic hallucination
 * that deterministic checks can't catch.
 *
 * The judge uses `.withStructuredOutput()` so it returns a per-span boolean
 * verdict directly — no fragile text parsing, and no empty output from
 * reasoning models starving a small token cap (which previously made this
 * gate silently fail-open and disabled the retry loop).
 *
 * Gracefully degrades if the LLM call fails — returns passed: true so a single
 * validator failure doesn't block the whole pipeline.
 */

import { z } from 'zod';
import { Answer } from '../generate/schema.js';
import { buildLangChainModel } from '../llm/langchain-model.js';
import { JUDGE_SYSTEM, buildJudgePrompt } from '../prompts/judge.js';
import { RUNTIME } from '../config/runtime.js';
import { recordUsage, usageFromMessage } from '../obs/usage.js';
import { logger } from '../logger.js';

export interface GroundingIssue {
  spanIndex: number;
  text: string;
  cited_chunk_ids: number[];
  entails: boolean;
  reason: string;
}

export interface GroundingVerdictLLM {
  passed: boolean;
  issues: GroundingIssue[];
  model?: string;
}

// Structured verdict the judge returns: one entry per evaluated span.
const GroundingResponseSchema = z.object({
  verdicts: z
    .array(
      z.object({
        span_index: z.number().int().nonnegative(),
        entails: z.boolean(),
        reason: z.string(),
      }),
    )
    .describe('One verdict per span, in span order'),
});

export async function validateGroundingWithLLM(
  answer: Answer,
  retrievedChunks: Array<{ id: string | number; payload: { text: string; case_name: string; citation?: string } }>,
): Promise<GroundingVerdictLLM> {
  try {
    const chunkMap = new Map<number, { text: string }>(
      retrievedChunks.map((c) => [Number(c.id), c.payload]),
    );
    const prompt = buildJudgePrompt(answer, chunkMap);
    const modelName = RUNTIME.modelName;
    const model = buildLangChainModel(modelName);

    // includeRaw exposes the AIMessage so judge token usage is attributed too.
    const structured = model.withStructuredOutput(GroundingResponseSchema, {
      name: 'grounding_verdicts',
      includeRaw: true,
    });
    const invoked = (await structured.invoke([
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: prompt },
    ])) as { raw: any; parsed: z.infer<typeof GroundingResponseSchema> | null };

    recordUsage(usageFromMessage('judge', modelName, invoked.raw));

    if (!invoked.parsed) {
      throw new Error('Judge structured output parsing failed');
    }
    const result = invoked.parsed;

    const verdictByIndex = new Map(result.verdicts.map((v) => [v.span_index, v]));
    const issues: GroundingIssue[] = [];

    for (let i = 0; i < answer.answer_spans.length; i++) {
      const span = answer.answer_spans[i];
      if (!span) continue;
      const verdict = verdictByIndex.get(i);
      // Missing verdict is treated as not-entailed (judge must cover every span).
      if (!verdict || !verdict.entails) {
        issues.push({
          spanIndex: i,
          text: span.text,
          cited_chunk_ids: span.citation_ids || [],
          entails: false,
          reason: verdict?.reason || '(no verdict returned for this span)',
        });
      }
    }

    return { passed: issues.length === 0, issues, model: modelName };
  } catch (err) {
    // Graceful degradation: log warning and fail open so the pipeline isn't blocked.
    logger.warn({
      action: 'grounding_check_failed',
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      passed: true,
      issues: [],
    };
  }
}
