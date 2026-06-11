/**
 * Retrieval pipeline: dense search, optionally refined by the cross-encoder.
 *
 * All call sites (server route, CLI, eval runner) go through retrieve() so the
 * rerank toggle and top-k from RUNTIME apply uniformly. When reranking is on,
 * we over-fetch RUNTIME.rerankPoolK candidates and let the cross-encoder pick
 * the top RUNTIME.topK; when off, this is a plain dense top-k search.
 */

import { searchDense, type SearchResult } from './qdrant-client.js';
import { rerank } from './reranker.js';
import { RUNTIME } from '../config/runtime.js';

export interface RetrievalOutcome {
  chunks: SearchResult[];
  /** Dense search latency in ms. */
  denseMs: number;
  /** Cross-encoder latency in ms, or null when reranking is off. */
  rerankMs: number | null;
}

export async function retrieve(query: string): Promise<RetrievalOutcome> {
  const denseStart = Date.now();

  if (!RUNTIME.rerank) {
    const chunks = await searchDense(query, RUNTIME.topK);
    return { chunks, denseMs: Date.now() - denseStart, rerankMs: null };
  }

  const poolK = Math.max(RUNTIME.rerankPoolK, RUNTIME.topK);
  const pool = await searchDense(query, poolK);
  const denseMs = Date.now() - denseStart;

  const rerankStart = Date.now();
  const chunks = await rerank(query, pool, RUNTIME.topK);
  return { chunks, denseMs, rerankMs: Date.now() - rerankStart };
}
