/**
 * Retrieval pipeline: dense search, optionally refined by the cross-encoder.
 *
 * All call sites (server route, CLI, eval runner) go through retrieve() so the
 * rerank toggle and top-k from RUNTIME apply uniformly. When reranking is on,
 * we over-fetch RUNTIME.rerankPoolK candidates and let the cross-encoder pick
 * the top RUNTIME.topK; when off, this is a plain dense top-k search.
 *
 * Comparative queries ("Rahimi vs Cargill", "how do X and Y differ") need TWO
 * cases in context, but a single dense query vector tends to favor one case and
 * starve the other below the top-k cutoff. We attack that from two sides:
 *   1. Per-entity sub-queries — parse the case entities out of the query and run
 *      a dense search for each, so the starved case is fetched DIRECTLY rather
 *      than hoped for in the combined-query ranking.
 *   2. Diversity selection — choose the final top-k round-robin by case_name, so
 *      each case contributes its best chunk before any case contributes a second.
 * Non-comparative queries are unaffected.
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

// Cue words that signal a query is asking to compare/contrast two+ cases.
// Deliberately conservative — a false positive only widens the candidate pool
// and reorders by case diversity; it never drops a relevant chunk.
const COMPARATIVE_CUES =
  /\b(versus|vs\.?|compared?\s+(?:to|with)|comparison|differ(?:s|ence|ences)?|distinguish|contrast|both\s+cases|each\s+(?:case|holding))\b|&/i;

export function isComparativeQuery(query: string): boolean {
  return COMPARATIVE_CUES.test(query);
}

/**
 * Parse the case entities out of a comparative query so each can be fetched on
 * its own. Splits on comparison connectors (vs / versus / &), then "between X
 * and Y", then a guarded "X and Y" — but never on a bare "v." (that is the
 * internal separator of a single case name like "Free Speech Coalition v.
 * Paxton", not a comparison). Returns [] when it can't confidently find two,
 * so the caller falls back to diversity-only retrieval.
 */
export function extractComparativeEntities(query: string): string[] {
  const core = (query.split(/[—:?]/)[0] ?? query).trim();

  // Primary: comparison connectors. \bvs\b matches "vs"/"vs." but NOT "v.".
  let parts = core
    .split(/\s*(?:\bvs\b\.?|\bversus\b|&)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return dedupeStrings(parts);

  // "between X and Y"
  const between = core.match(/\bbetween\s+(.+?)\s+and\s+(.+)$/i);
  if (between?.[1] && between?.[2]) {
    return dedupeStrings([between[1].trim(), between[2].trim()]);
  }

  // "X and Y" — only when both sides look like case references, so ordinary
  // queries with a stray "and" are not split.
  parts = core.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2 && parts.every(looksLikeCaseRef)) return dedupeStrings(parts);

  return [];
}

function looksLikeCaseRef(s: string): boolean {
  return (
    /\bv\.?\b/i.test(s) || // "X v. Y"
    /[A-Z][a-z]+\s+[A-Z][a-z]+/.test(s) || // Two Capitalized Words
    /\b[A-Z]{2,}\b/.test(s) // an acronym party (SEC, SFFA, FDA)
  );
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

/** Merge candidate pools, keeping the best score per chunk id, sorted desc. */
function mergeByBestScore(pools: SearchResult[][]): SearchResult[] {
  const best = new Map<string | number, SearchResult>();
  for (const pool of pools) {
    for (const r of pool) {
      const existing = best.get(r.id);
      if (!existing || r.score > existing.score) best.set(r.id, r);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Select `topK` results from a (score-ordered) pool with diversity across
 * case_name. Round-robins over cases ranked by their best-scoring chunk: every
 * case contributes its top chunk before any case contributes a second. For a
 * two-case comparison this guarantees both cases land in the top two slots even
 * when one case dominates the raw similarity ranking.
 */
export function selectDiverseByCase(pool: SearchResult[], topK: number): SearchResult[] {
  if (pool.length <= topK) return pool.slice(0, topK);

  // Group while preserving the pool's existing (score-descending) order.
  const groups = new Map<string, SearchResult[]>();
  for (const r of pool) {
    const key = r.payload.case_name;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  // Order cases by their best (first) chunk's score, descending.
  const ordered = [...groups.values()].sort(
    (a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0),
  );

  const selected: SearchResult[] = [];
  for (let round = 0; selected.length < topK; round++) {
    let progressed = false;
    for (const group of ordered) {
      const item = group[round];
      if (item) {
        selected.push(item);
        progressed = true;
        if (selected.length >= topK) break;
      }
    }
    if (!progressed) break; // pool exhausted
  }

  return selected.slice(0, topK);
}

/** Build the comparative candidate pool: combined query + one sub-query per entity. */
async function comparativePool(query: string): Promise<SearchResult[]> {
  const poolK = Math.max(RUNTIME.comparativePoolK, RUNTIME.topK);
  const entities = RUNTIME.comparativeSubQueries ? extractComparativeEntities(query) : [];

  if (entities.length < 2) {
    // No parseable entities — diversity-only over a single widened pool.
    return searchDense(query, poolK);
  }

  // Give each entity enough slots that its top chunks survive the merge.
  const subK = Math.max(RUNTIME.topK, Math.ceil(poolK / entities.length));
  const pools = await Promise.all([
    searchDense(query, poolK),
    ...entities.map((entity) => searchDense(entity, subK)),
  ]);
  return mergeByBestScore(pools);
}

export async function retrieve(query: string): Promise<RetrievalOutcome> {
  const comparative = RUNTIME.comparativeDiversity && isComparativeQuery(query);
  const denseStart = Date.now();

  if (comparative) {
    const pool = await comparativePool(query);
    const denseMs = Date.now() - denseStart;

    if (!RUNTIME.rerank) {
      return { chunks: selectDiverseByCase(pool, RUNTIME.topK), denseMs, rerankMs: null };
    }
    const rerankStart = Date.now();
    const reranked = await rerank(query, pool, pool.length);
    return {
      chunks: selectDiverseByCase(reranked, RUNTIME.topK),
      denseMs,
      rerankMs: Date.now() - rerankStart,
    };
  }

  // Non-comparative: plain dense top-k, optionally reranked.
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
