/**
 * Answer generation with native structured output.
 *
 * `.withStructuredOutput()` drives each provider's structured-output API
 * (Gemini responseSchema, OpenAI json-schema / tool-calling, Groq tool
 * calling), so the parsed result is schema-conforming by construction —
 * no "parse free text -> JSON.parse -> Zod" fallback that breaks on
 * markdown fences or reasoning models starving a small token cap.
 */

import { buildLangChainModel } from '../llm/langchain-model.js';
import { AnswerSchema, type Answer } from './schema.js';
import { RUNTIME } from '../config/runtime.js';
import { recordUsage, usageFromMessage } from '../obs/usage.js';
import { logger } from '../logger.js';

/**
 * Generate answer with structured output validation.
 * Throws if the model fails to produce a schema-valid answer.
 */
export async function generateWithStructuredOutput(
  systemPrompt: string,
  userMessage: string,
  modelName: string = RUNTIME.modelName,
): Promise<Answer> {
  const model = buildLangChainModel(modelName);

  // includeRaw exposes the underlying AIMessage so we can record token usage;
  // parsed output is still validated against AnswerSchema.
  const structuredModel = model.withStructuredOutput(AnswerSchema, {
    name: 'answer',
    includeRaw: true,
  });
  const result = (await structuredModel.invoke([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ])) as { raw: any; parsed: Answer | null };

  recordUsage(usageFromMessage('generate', modelName, result.raw));

  if (!result.parsed) {
    throw new Error('Structured output parsing failed (no parsed answer returned)');
  }
  return result.parsed;
}

/**
 * Safely generate with structured output, returning null on failure.
 * Used in retry loops where we want to handle failures gracefully.
 */
export async function generateWithStructuredOutputSafe(
  systemPrompt: string,
  userMessage: string,
  modelName: string = RUNTIME.modelName,
): Promise<Answer | null> {
  try {
    return await generateWithStructuredOutput(systemPrompt, userMessage, modelName);
  } catch (err) {
    logger.warn({
      action: 'structured_generation_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
