#!/usr/bin/env node
/**
 * Retrieval-only matrix study: zero LLM calls, fully local and free.
 *
 * Measures the retrieval-side dimensions of the configuration sweep (chunk size,
 * top-k, reranking) against the platinum question set using the local
 * embedder, Qdrant, and the local cross-encoder. Generation-side dimensions
 * (validators, prompt caching) require paid LLM calls and are reported
 * separately from small samples.
 *
 * Efficiency trick: one dense search at k=12 per question yields hit@5,
 * hit@8, and hit@12 by slicing the same ranked list — the top-k "sweep" costs
 * nothing extra.
 *
 * Usage:
 *   npm run study:retrieval                  # all ready collections
 *   npm run study:retrieval -- --rerank      # include the rerank cell (chunk 800)
 *
 * Output: reports/retrieval-study.json (cells merge across runs, so run it
 * again as more collections finish ingesting).
 */

import 'dotenv/config';
import * as fs from 'fs';
import { searchDense, type SearchResult } from '../src/retrieval/qdrant-client.js';
import { rerank } from '../src/retrieval/reranker.js';
import { applyRuntimeOverrides } from '../src/config/runtime.js';

interface Question {
  id: string;
  question: string;
  expected_citations: string[];
  category: string;
}

const CHUNK_SIZES = [512, 800, 1200] as const;
const K_MAX = 12;
const KS = [5, 8, 12] as const;
const RERANK_POOL = 16;
const RERANK_TOPK = 8;

const EXPECTED_POINTS: Record<number, number> = { 512: 34343, 800: 27374, 1200: 15382 };

function collectionFor(chunkSize: number): string {
  return chunkSize === 800 ? 'scotus_opinions' : `scotus_opinions_${chunkSize}`;
}

function isChunkRelevant(chunk: SearchResult, expected: string[]): boolean {
  const caseName = chunk.payload.case_name || '';
  const citation = chunk.payload.citation || '';
  for (const exp of expected) {
    const expCase = exp.split(',')[0]!;
    if (caseName.includes(expCase) || citation.includes(expCase) || exp.includes(caseName)) {
      return true;
    }
  }
  return false;
}

function firstRelevantRank(chunks: SearchResult[], expected: string[]): number | null {
  for (let i = 0; i < chunks.length; i++) {
    if (isChunkRelevant(chunks[i]!, expected)) return i + 1;
  }
  return null;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.floor(sorted.length * p)] ?? sorted[sorted.length - 1] ?? 0;
}

async function collectionReady(chunkSize: number): Promise<boolean> {
  const url = process.env.QDRANT_URL || 'http://localhost:6333';
  try {
    const res = await fetch(`${url}/collections/${collectionFor(chunkSize)}`);
    if (!res.ok) return false;
    const body: any = await res.json();
    return (body?.result?.points_count ?? 0) >= EXPECTED_POINTS[chunkSize]! * 0.9;
  } catch {
    return false;
  }
}

interface DenseCell {
  kind: 'dense';
  chunk_size: number;
  questions: number;
  hit_at: Record<string, number>;
  mrr_at_12: number;
  avg_top1_score_in_corpus: number;
  avg_top1_score_out_of_corpus: number;
  search_p50_ms: number;
  search_p95_ms: number;
}

interface RerankCell {
  kind: 'rerank';
  chunk_size: number;
  pool: number;
  top_k: number;
  questions: number;
  dense_hit_at_8: number;
  rerank_hit_at_8: number;
  dense_mrr: number;
  rerank_mrr: number;
  rerank_p50_ms: number;
  rerank_p95_ms: number;
  avg_rank_improvement: number;
}

async function runDenseCell(chunkSize: number, questions: Question[]): Promise<DenseCell> {
  applyRuntimeOverrides({ collectionName: collectionFor(chunkSize) });

  const withExpected = questions.filter((q) => q.expected_citations.length > 0);
  const outOfCorpus = questions.filter((q) => q.category === 'out_of_corpus');

  const latencies: number[] = [];
  const hits: Record<number, number> = { 5: 0, 8: 0, 12: 0 };
  let mrrSum = 0;
  const top1In: number[] = [];
  const top1Out: number[] = [];

  for (const q of questions) {
    const start = Date.now();
    const results = await searchDense(q.question, K_MAX);
    latencies.push(Date.now() - start);

    const top1 = results[0]?.score ?? 0;
    if (q.category === 'out_of_corpus') top1Out.push(top1);
    else top1In.push(top1);

    if (q.expected_citations.length > 0) {
      const rank = firstRelevantRank(results, q.expected_citations);
      if (rank !== null) {
        mrrSum += 1 / rank;
        for (const k of KS) if (rank <= k) hits[k] = (hits[k] ?? 0) + 1;
      }
    }
  }

  latencies.sort((a, b) => a - b);
  const n = withExpected.length;

  console.log(`  dense chunk=${chunkSize}: hit@8 ${(hits[8]! / n * 100).toFixed(0)}% | MRR ${(mrrSum / n).toFixed(3)} | p50 ${percentile(latencies, 0.5)}ms`);

  return {
    kind: 'dense',
    chunk_size: chunkSize,
    questions: questions.length,
    hit_at: {
      '5': Number((hits[5]! / n).toFixed(3)),
      '8': Number((hits[8]! / n).toFixed(3)),
      '12': Number((hits[12]! / n).toFixed(3)),
    },
    mrr_at_12: Number((mrrSum / n).toFixed(3)),
    avg_top1_score_in_corpus: Number((top1In.reduce((a, b) => a + b, 0) / (top1In.length || 1)).toFixed(3)),
    avg_top1_score_out_of_corpus: Number((top1Out.reduce((a, b) => a + b, 0) / (top1Out.length || 1)).toFixed(3)),
    search_p50_ms: percentile(latencies, 0.5),
    search_p95_ms: percentile(latencies, 0.95),
  };
}

async function runRerankCell(chunkSize: number, questions: Question[]): Promise<RerankCell> {
  applyRuntimeOverrides({ collectionName: collectionFor(chunkSize) });

  const withExpected = questions.filter((q) => q.expected_citations.length > 0);
  const latencies: number[] = [];
  let denseHits = 0;
  let rerankHits = 0;
  let denseMrr = 0;
  let rerankMrr = 0;
  const improvements: number[] = [];

  for (const q of withExpected) {
    const pool = await searchDense(q.question, RERANK_POOL);

    const start = Date.now();
    const reranked = await rerank(q.question, pool, RERANK_TOPK);
    latencies.push(Date.now() - start);

    const denseRank = firstRelevantRank(pool.slice(0, RERANK_TOPK), q.expected_citations);
    const rerankRank = firstRelevantRank(reranked, q.expected_citations);
    const poolRank = firstRelevantRank(pool, q.expected_citations);

    if (denseRank !== null) { denseHits++; denseMrr += 1 / denseRank; }
    if (rerankRank !== null) { rerankHits++; rerankMrr += 1 / rerankRank; }
    // Rank improvement only measurable when the relevant chunk is in the pool
    if (poolRank !== null && rerankRank !== null && denseRank !== null) {
      improvements.push(denseRank - rerankRank);
    }
  }

  latencies.sort((a, b) => a - b);
  const n = withExpected.length;

  console.log(`  rerank chunk=${chunkSize}: hit@8 ${(denseHits / n * 100).toFixed(0)}% -> ${(rerankHits / n * 100).toFixed(0)}% | MRR ${(denseMrr / n).toFixed(3)} -> ${(rerankMrr / n).toFixed(3)} | p50 ${percentile(latencies, 0.5)}ms`);

  return {
    kind: 'rerank',
    chunk_size: chunkSize,
    pool: RERANK_POOL,
    top_k: RERANK_TOPK,
    questions: n,
    dense_hit_at_8: Number((denseHits / n).toFixed(3)),
    rerank_hit_at_8: Number((rerankHits / n).toFixed(3)),
    dense_mrr: Number((denseMrr / n).toFixed(3)),
    rerank_mrr: Number((rerankMrr / n).toFixed(3)),
    rerank_p50_ms: percentile(latencies, 0.5),
    rerank_p95_ms: percentile(latencies, 0.95),
    avg_rank_improvement: Number((improvements.reduce((a, b) => a + b, 0) / (improvements.length || 1)).toFixed(2)),
  };
}

async function main() {
  const includeRerank = process.argv.includes('--rerank');
  const outPath = 'reports/retrieval-study.json';

  const questions: Question[] = fs
    .readFileSync('evals/platinum.jsonl', 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  console.log(`Loaded ${questions.length} platinum questions`);

  // Merge with previous runs: cells re-run replace their old entry
  let cells: Array<DenseCell | RerankCell> = [];
  if (fs.existsSync(outPath)) {
    try { cells = JSON.parse(fs.readFileSync(outPath, 'utf-8')).cells ?? []; } catch { /* fresh */ }
  }
  const upsert = (cell: DenseCell | RerankCell) => {
    cells = cells.filter((c) => !(c.kind === cell.kind && c.chunk_size === cell.chunk_size));
    cells.push(cell);
  };

  for (const chunkSize of CHUNK_SIZES) {
    if (!(await collectionReady(chunkSize))) {
      console.log(`chunk=${chunkSize}: collection not ready, skipping (re-run later)`);
      continue;
    }
    console.log(`chunk=${chunkSize}: running dense cell...`);
    upsert(await runDenseCell(chunkSize, questions));
  }

  if (includeRerank) {
    if (await collectionReady(800)) {
      console.log('rerank cell (chunk=800)...');
      upsert(await runRerankCell(800, questions));
    } else {
      console.log('rerank: chunk=800 collection not ready, skipping');
    }
  }

  fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), cells }, null, 2));
  console.log(`\n✓ ${cells.length} cells written to ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
