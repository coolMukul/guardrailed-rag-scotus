/**
 * Mutable runtime configuration for sweep experiments.
 *
 * CONFIG (constants.ts) holds env-derived defaults that are frozen at import
 * time. The matrix sweep needs to vary retrieval and generation parameters
 * per run without restarting the process or editing .env, so the pipeline
 * modules read these knobs from RUNTIME instead.
 *
 * Defaults mirror CONFIG, so behaviour is unchanged unless a script calls
 * applyRuntimeOverrides() (run-eval.ts does this from CLI flags).
 *
 * Rule of thumb: pipeline modules (retrieval, generation, validators,
 * guardrails) read RUNTIME; CONFIG is read only by config/bootstrap code and
 * by RUNTIME's own defaults. Reading CONFIG from a pipeline module silently
 * ignores sweep overrides — that class of bug is why this rule exists.
 */

import { CONFIG } from './constants.js';

export type Provider = 'groq' | 'litellm' | 'gemini';

export interface RuntimeConfig {
  /** Qdrant collection to search (chunk-size sweeps use one collection per size). */
  collectionName: string;
  /** Number of chunks handed to the generator. */
  topK: number;
  /** Whether to rerank a larger candidate pool down to topK. */
  rerank: boolean;
  /** Candidate pool size fetched from Qdrant when reranking is on. */
  rerankPoolK: number;
  /** Whether to use the cache-friendly (long stable prefix) prompt layout. */
  promptCache: boolean;
  /** LLM provider for generation + grounding judge. */
  provider: Provider;
  /** Model name passed to the provider. */
  modelName: string;
}

export const RUNTIME: RuntimeConfig = {
  collectionName: CONFIG.retrieval.collectionName,
  topK: CONFIG.retrieval.topK,
  rerank: false,
  rerankPoolK: 16,
  promptCache: false,
  provider: CONFIG.generation.provider,
  modelName: CONFIG.generation.modelName,
};

export function applyRuntimeOverrides(overrides: Partial<RuntimeConfig>): void {
  Object.assign(RUNTIME, overrides);
}
