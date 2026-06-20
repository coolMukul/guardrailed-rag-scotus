/**
 * Quality-relevant config snapshot + stable fingerprint.
 *
 * The eval harness stamps every run with this fingerprint and refuses to
 * compare runs whose fingerprints differ, so two invariants matter:
 *
 * 1. Values are read from RUNTIME/CONFIG — the same objects the pipeline
 *    reads — never a parallel copy that can drift. That is why both
 *    getQualityConfig() and computeConfigFingerprint() are functions, not
 *    module-level constants: RUNTIME is mutable (applyRuntimeOverrides), so
 *    the snapshot must be taken at call time.
 * 2. The hash is computed over a canonical JSON encoding with sorted keys,
 *    so identical config produces identical fingerprints across restarts.
 *    Nothing time- or identity-dependent goes into the hash.
 */

import { createHash } from 'node:crypto';
import { CONFIG } from './constants.js';
import { RUNTIME } from './runtime.js';
import { guardrailsConfig } from './guardrails.js';
import { getPromptVersion } from '../prompts/generation.js';
import { JUDGE_VERSION } from '../prompts/judge.js';
import { CORPUS_SCOPE_VERSION } from '../validator/corpus-scope.js';
import { INJECTION_CLASSIFIER_VERSION } from '../prompts/injection.js';

/**
 * Every config value that can affect answer quality. No secrets.
 * Keys stay FLAT: the fingerprint serializes with a sorted-key replacer
 * array, and JSON.stringify applies that array at every nesting level — a
 * nested object's keys would be silently dropped from the hash.
 */
export interface QualityConfig {
  provider: string;
  model: string;
  collection: string;
  top_k: number;
  rerank: boolean;
  rerank_pool_k: number;
  comparative_diversity: boolean;
  comparative_pool_k: number;
  comparative_sub_queries: boolean;
  grounding_mode: string;
  corpus_scope_guard: boolean;
  corpus_scope_version: string;
  prompt_version: string;
  judge_version: string;
  prompt_cache: boolean;
  validator_retries: number;
  temperature: number;
  max_tokens: number;
  // Guardrail calibration: blocks are a scored outcome for the eval harness
  // (abstention/guardrail metrics), so classifier behavior is quality config.
  guardrail_pii_enabled: boolean;
  guardrail_injection_enabled: boolean;
  guardrail_injection_threshold: number;
  guardrail_policy_enabled: boolean;
  injection_classifier_version: string;
}

export function getQualityConfig(): QualityConfig {
  return {
    provider: RUNTIME.provider,
    model: RUNTIME.modelName,
    collection: RUNTIME.collectionName,
    top_k: RUNTIME.topK,
    rerank: RUNTIME.rerank,
    rerank_pool_k: RUNTIME.rerankPoolK,
    comparative_diversity: RUNTIME.comparativeDiversity,
    comparative_pool_k: RUNTIME.comparativePoolK,
    comparative_sub_queries: RUNTIME.comparativeSubQueries,
    grounding_mode: RUNTIME.groundingMode,
    corpus_scope_guard: RUNTIME.corpusScopeGuard,
    corpus_scope_version: CORPUS_SCOPE_VERSION,
    prompt_version: getPromptVersion(),
    judge_version: JUDGE_VERSION,
    prompt_cache: RUNTIME.promptCache,
    validator_retries: RUNTIME.validatorRetries,
    temperature: CONFIG.generation.temperature,
    max_tokens: CONFIG.generation.maxTokens,
    guardrail_pii_enabled: guardrailsConfig.pii.enabled,
    guardrail_injection_enabled: guardrailsConfig.injection.enabled,
    guardrail_injection_threshold: guardrailsConfig.injection.threshold,
    guardrail_policy_enabled: guardrailsConfig.policy.enabled,
    injection_classifier_version: INJECTION_CLASSIFIER_VERSION,
  };
}

/**
 * Short stable hash of the quality config. Returned by GET /meta and in
 * /ask diagnostics; the two must always agree, which they do by construction
 * because both call this function against the live RUNTIME.
 */
export function computeConfigFingerprint(): string {
  const cfg = getQualityConfig();
  const canonical = JSON.stringify(cfg, Object.keys(cfg).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}
