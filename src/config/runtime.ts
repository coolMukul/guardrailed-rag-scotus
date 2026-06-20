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

export type Provider = 'groq' | 'openai' | 'gemini';

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
  /** Max validator-triggered regenerations per request. */
  validatorRetries: number;
  /**
   * For comparative queries (two+ cases), over-fetch and select the final topK
   * with diversity across case_name so a single dominant case can't starve the
   * other(s) out of the context window. When off, comparative queries use the
   * plain dense/rerank path.
   */
  comparativeDiversity: boolean;
  /** Candidate pool fetched before diversity selection for comparative queries. */
  comparativePoolK: number;
  /**
   * For comparative queries, also issue a dense sub-query per extracted case
   * entity and merge the pools, so a case the single combined-query vector
   * starves is fetched directly. Falls back to diversity-only when no entities
   * can be parsed.
   */
  comparativeSubQueries: boolean;
  /**
   * Grounding salvage. 'per_span' keeps the spans the judge supports and drops
   * only the unsupported ones, abstaining only when no span survives.
   * 'all_or_nothing' abstains if any span fails (the original behavior).
   */
  groundingMode: 'per_span' | 'all_or_nothing';
  /**
   * Deterministic corpus-scope guard: if the question names a specific case
   * (PARTY v. PARTY) that is absent from the retrieved case-set, force
   * abstention before generation. Enforces the strict out-of-corpus contract
   * that prompt-only rules leaked on.
   */
  corpusScopeGuard: boolean;
}

export const RUNTIME: RuntimeConfig = {
  collectionName: CONFIG.retrieval.collectionName,
  topK: CONFIG.retrieval.topK,
  rerank: false,
  rerankPoolK: 16,
  promptCache: false,
  provider: CONFIG.generation.provider,
  modelName: CONFIG.generation.modelName,
  validatorRetries: 1,
  comparativeDiversity: true,
  comparativePoolK: 24,
  comparativeSubQueries: true,
  groundingMode: 'per_span',
  corpusScopeGuard: true,
};

export function applyRuntimeOverrides(overrides: Partial<RuntimeConfig>): void {
  Object.assign(RUNTIME, overrides);
}
