/**
 * Cross-encoder reranker over dense-retrieval candidates.
 *
 * Dense retrieval (bi-encoder) embeds query and chunk independently, so it can
 * miss fine-grained relevance ("Miranda warnings" vs "Miranda's holding on
 * custodial interrogation"). A cross-encoder reads the query and chunk
 * TOGETHER through one transformer pass and scores the pair directly — slower
 * (one forward pass per candidate) but considerably more precise.
 *
 * Usage pattern: over-fetch a candidate pool from Qdrant (e.g. 24), rerank,
 * keep the top-k (e.g. 8). The pool size bounds the added latency.
 *
 * Model: bge-reranker-base via @xenova/transformers — local CPU, no API cost.
 * Note: the model truncates pairs at 512 tokens, so for large chunks only the
 * head of the chunk informs the score.
 */

import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers';
import { logger } from '../logger.js';
import type { SearchResult } from './qdrant-client.js';

const RERANKER_MODEL = 'Xenova/bge-reranker-base';

// Score pairs in small batches: keeps peak memory bounded on CPU
const BATCH_SIZE = 8;

// Cross-encoder cost is quadratic in sequence length: scoring full 3,200-char
// chunks on CPU took ~1.5-2s per pair. Scoring only the head of each chunk
// (~250 tokens) cuts that ~6x with little relevance loss — lead text carries
// the case name and topic. The GENERATOR still receives the full chunk.
const MAX_PASSAGE_CHARS = 1000;

let tokenizer: any = null;
let model: any = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (model && tokenizer) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const start = Date.now();
      logger.info({ action: 'reranker_load_start', model: RERANKER_MODEL });
      tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
      model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL);
      logger.info({ action: 'reranker_load_complete', elapsed: Date.now() - start });
    })();
  }
  return loadPromise;
}

export interface RerankedResult extends SearchResult {
  /** Cross-encoder relevance score in [0, 1] (sigmoid of the model logit). */
  rerank_score: number;
}

/**
 * Score each candidate against the query and return the top-k by relevance.
 * Falls back to the original dense ordering if the reranker fails to load.
 */
export async function rerank(
  query: string,
  candidates: SearchResult[],
  topK: number,
): Promise<RerankedResult[]> {
  if (candidates.length === 0) return [];

  try {
    await ensureLoaded();
  } catch (err) {
    logger.warn({
      action: 'reranker_load_failed_fallback_dense',
      error: err instanceof Error ? err.message : String(err),
    });
    return candidates.slice(0, topK).map((c) => ({ ...c, rerank_score: c.score }));
  }

  const start = Date.now();
  const scores: number[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const queries = batch.map(() => query);
    const texts = batch.map((c) => c.payload.text);

    const inputs = tokenizer(queries, {
      text_pair: texts.map((t) => t.slice(0, MAX_PASSAGE_CHARS)),
      padding: true,
      truncation: true,
    });
    const output = await model(inputs);

    // logits: Tensor of shape [batch, 1]; sigmoid maps to a 0-1 relevance score
    const logits: number[] = Array.from(output.logits.data as Float32Array);
    for (const logit of logits) {
      scores.push(1 / (1 + Math.exp(-logit)));
    }
  }

  const reranked = candidates
    .map((c, i) => ({ ...c, rerank_score: scores[i] ?? 0 }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topK);

  logger.info({
    action: 'rerank_complete',
    poolSize: candidates.length,
    topK,
    elapsed: Date.now() - start,
    topScore: reranked[0]?.rerank_score,
  });

  return reranked;
}
