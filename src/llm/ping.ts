/**
 * Cheap LLM-provider connectivity check for the readiness probe.
 *
 * Uses the provider's model-listing endpoint rather than a chat completion:
 * it authenticates with the same API key the pipeline uses and exercises the
 * same network path, but costs zero tokens — so health polling can never eat
 * into chat rate limits, no matter how often /ready is hit.
 */

import { CONFIG } from '../config/constants.js';
import { RUNTIME } from '../config/runtime.js';

export async function pingLLM(timeoutMs = 5000): Promise<void> {
  const provider = RUNTIME.provider;
  let url: string;
  const headers: Record<string, string> = {};

  if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/models';
    headers.Authorization = `Bearer ${CONFIG.groq.apiKey}`;
  } else if (provider === 'openai') {
    url = `${(CONFIG.openai.baseUrl ?? '').trim().replace(/\/+$/, '')}/models`;
    if (CONFIG.openai.apiKey) headers.Authorization = `Bearer ${CONFIG.openai.apiKey}`;
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${CONFIG.gemini.apiKey}`;
  } else {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`model endpoint returned ${res.status}`);
  }
}
