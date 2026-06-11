#!/usr/bin/env node
/**
 * Staged matrix sweep orchestrator for the cost/latency study.
 *
 * Runs run-eval.ts once per configuration cell, sequentially, collecting
 * aggregated rows into reports/study-raw.json (run-eval appends them).
 *
 * Staged design instead of the full 3x3x2x2 factorial: each stage varies ONE
 * dimension around the baseline, which answers "what does this knob cost/buy?"
 * directly with 8 cells instead of 36 (one-factor-at-a-time, plus the combined
 * recommended cell). Cells already present in study-raw.json are skipped, so
 * the sweep is resumable; delete a row (or the file) to re-run a cell.
 *
 * Usage:
 *   npm run study                       # all stages
 *   npm run study -- --delay 4000       # slower pacing for tighter rate limits
 *   npm run study -- --limit 10         # quick validation pass
 *   npm run study -- --model <name> --provider gemini
 */

import 'dotenv/config';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface Cell {
  stage: string;
  chunkSize: number;
  topK: number;
  rerank: boolean;
  cache: boolean;
}

// One-factor-at-a-time around the baseline (chunk=800, k=8, rerank off, cache off)
const CELLS: Cell[] = [
  // 5a: baseline
  { stage: '5a-baseline', chunkSize: 800, topK: 8, rerank: false, cache: false },
  // 5b: chunk size sweep
  { stage: '5b-chunk', chunkSize: 512, topK: 8, rerank: false, cache: false },
  { stage: '5b-chunk', chunkSize: 1200, topK: 8, rerank: false, cache: false },
  // 5c: top-k sweep
  { stage: '5c-topk', chunkSize: 800, topK: 5, rerank: false, cache: false },
  { stage: '5c-topk', chunkSize: 800, topK: 12, rerank: false, cache: false },
  // 5d: reranking
  { stage: '5d-rerank', chunkSize: 800, topK: 8, rerank: true, cache: false },
  // 5e: prompt caching (isolated, and combined with reranking = recommended candidate)
  { stage: '5e-cache', chunkSize: 800, topK: 8, rerank: false, cache: true },
  { stage: '5e-cache', chunkSize: 800, topK: 8, rerank: true, cache: true },
];

function cellKey(c: Cell): string {
  return `chunk${c.chunkSize}-k${c.topK}-rerank${c.rerank ? 'on' : 'off'}-cache${c.cache ? 'on' : 'off'}`;
}

function collectionForChunkSize(chunkSize: number): string {
  return chunkSize === 800 ? 'scotus_opinions' : `scotus_opinions_${chunkSize}`;
}

async function collectionReady(chunkSize: number): Promise<boolean> {
  const url = process.env.QDRANT_URL || 'http://localhost:6333';
  const name = collectionForChunkSize(chunkSize);
  try {
    const res = await fetch(`${url}/collections/${name}`);
    if (!res.ok) return false;
    const body: any = await res.json();
    const count = body?.result?.points_count ?? 0;
    // Expected sizes: ~27K (800), ~34K (512), ~15K (1200). 90% threshold guards
    // against racing a still-running ingest.
    const expected = chunkSize === 512 ? 34343 : chunkSize === 1200 ? 15382 : 27374;
    return count >= expected * 0.9;
  } catch {
    return false;
  }
}

function parseArgs(): { delay: number; limit: number | null; model: string | null; provider: string | null; dataset: string } {
  const args = process.argv.slice(2);
  const out = {
    delay: 4000,
    limit: null as number | null,
    model: null as string | null,
    provider: null as string | null,
    // The study runs on the platinum set: authored against cases that are
    // actually in the 2023-2025 corpus, so retrieval metrics carry signal.
    dataset: 'evals/platinum.jsonl',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delay' && args[i + 1]) { out.delay = parseInt(args[i + 1]!, 10); i++; }
    else if (args[i] === '--limit' && args[i + 1]) { out.limit = parseInt(args[i + 1]!, 10); i++; }
    else if (args[i] === '--model' && args[i + 1]) { out.model = args[i + 1]!; i++; }
    else if (args[i] === '--provider' && args[i + 1]) { out.provider = args[i + 1]!; i++; }
    else if (args[i] === '--dataset' && args[i + 1]) { out.dataset = args[i + 1]!; i++; }
  }
  return out;
}

async function main() {
  const cli = parseArgs();
  const studyRawPath = 'reports/study-raw.json';

  let completed = new Set<string>();
  if (fs.existsSync(studyRawPath)) {
    try {
      const rows = JSON.parse(fs.readFileSync(studyRawPath, 'utf-8'));
      completed = new Set(rows.map((r: any) => r.key));
    } catch {
      // unreadable file: run everything
    }
  }

  fs.mkdirSync('reports/sweep', { recursive: true });

  console.log(`Sweep: ${CELLS.length} cells | delay ${cli.delay}ms | ${cli.limit ?? 'all'} questions/cell`);
  console.log(`Already completed: ${[...completed].join(', ') || '(none)'}\n`);

  const startedAt = Date.now();

  for (const [index, cell] of CELLS.entries()) {
    const key = cellKey(cell);
    console.log(`\n=== [${index + 1}/${CELLS.length}] ${cell.stage} :: ${key} ===`);

    if (completed.has(key)) {
      console.log('Already in study-raw.json — skipping.');
      continue;
    }

    if (!(await collectionReady(cell.chunkSize))) {
      console.log(`Collection ${collectionForChunkSize(cell.chunkSize)} not ready (ingest still running?) — skipping for now.`);
      console.log('Re-run "npm run study" once ingest completes; finished cells are skipped automatically.');
      continue;
    }

    const args = [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/run-eval.ts',
      '--chunk-size', String(cell.chunkSize),
      '--top-k', String(cell.topK),
      '--rerank', cell.rerank ? 'on' : 'off',
      '--cache', cell.cache ? 'on' : 'off',
      '--delay', String(cli.delay),
      '--output', `reports/sweep/${key}.json`,
      '--dataset', cli.dataset,
    ];
    if (cli.limit) args.push('--limit', String(cli.limit));
    if (cli.model) args.push('--model', cli.model);
    if (cli.provider) args.push('--provider', cli.provider);

    // Fresh child process per cell: clean module state (model caches, runtime
    // overrides) and crash isolation — one failed cell doesn't sink the sweep.
    const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`Cell ${key} exited with status ${res.status}; continuing with next cell.`);
    }
  }

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nSweep pass complete in ${elapsedMin} min.`);

  if (fs.existsSync(studyRawPath)) {
    const rows = JSON.parse(fs.readFileSync(studyRawPath, 'utf-8'));
    console.log(`study-raw.json now holds ${rows.length} cells:`);
    for (const r of rows) {
      console.log(
        `  ${r.key.padEnd(40)} p50=${r.metrics.p50_latency_ms}ms recall=${r.metrics.citation_recall} $${r.metrics.cost_per_query_usd}/q`,
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
