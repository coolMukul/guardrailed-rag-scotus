/**
 * Shared chat-model factory: the single place where a provider name becomes
 * a configured model instance. Every LLM call in the pipeline (generation,
 * grounding judge, injection classifier) goes through here, so provider
 * quirks are handled once:
 *
 *   - groq    -> RateLimitedChatGroq (free-tier rate limiter as a pre-call gate)
 *   - gemini  -> ChatGoogleGenerativeAI (native responseSchema structured output)
 *   - openai  -> ChatOpenAI pointed at an OpenAI-compatible proxy (json-schema / tool-calling)
 *
 * Temperature policy lives here and only here: the GPT-5 family rejects any
 * temperature other than 1, everything else uses the configured default.
 *
 * Token-cap policy: Groq's llama models get the configured cap (cheap
 * insurance against runaway output); reasoning-capable providers get none,
 * because they spend tokens thinking before emitting the answer and a small
 * cap truncates the output to empty or invalid JSON.
 */

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { CONFIG } from '../config/constants.js';
import { RUNTIME } from '../config/runtime.js';
import { RateLimitedChatGroq } from './groq-chat.js';

/**
 * GPT-5 family requires temperature=1 (any other value is rejected by the API).
 */
export function isGpt5Model(modelName: string): boolean {
  const m = modelName.toLowerCase();
  return m.includes('gpt-5') || m.includes('gpt5') || m.includes('gpt54');
}

function resolveTemperature(modelName: string): number {
  return isGpt5Model(modelName) ? 1 : CONFIG.generation.temperature;
}

/**
 * Build a chat model for the active provider (RUNTIME.provider).
 */
export function buildLangChainModel(modelName: string): BaseChatModel {
  const provider = RUNTIME.provider;
  const temperature = resolveTemperature(modelName);

  if (provider === 'groq') {
    return new RateLimitedChatGroq({
      model: modelName,
      apiKey: CONFIG.groq.apiKey,
      temperature,
      maxTokens: CONFIG.generation.maxTokens,
    });
  }

  if (provider === 'gemini') {
    return new ChatGoogleGenerativeAI({
      model: modelName,
      apiKey: CONFIG.gemini.apiKey,
      temperature,
    });
  }

  if (provider === 'openai') {
    return new ChatOpenAI({
      model: modelName,
      // the proxy supplies the real key; ChatOpenAI requires a non-empty value.
      apiKey: CONFIG.openai.apiKey ?? 'sk-openai-proxy',
      temperature,
      configuration: {
        // Guard against a stray space in LLM_BASE_URL (.env had a leading space).
        baseURL: CONFIG.openai.baseUrl?.trim(),
      },
    });
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}
