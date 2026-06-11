import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { chunkCluster, type Chunk, type ChunkOptions, TARGET_CHARS, OVERLAP_CHARS } from '../src/ingest/chunker.js';
import type { SectionMeta } from '../src/ingest/cleaner.js';
import type { CourtListenerCitation } from '../src/ingest/courtlistener-client.js';
import { ensureScotusDirs } from '../src/config/paths.js';

interface MetaFile {
  cluster_id: number;
  case_name: string;
  case_name_short: string | null;
  case_name_full: string | null;
  citations: CourtListenerCitation[] | null;
  date_filed: string | null;
  docket_id: number | null;
  opinions: { id: number; type: string; author: string | null }[];
  sections: SectionMeta[];
  text_length: number;
  fetched_at: string;
}

async function processOne(
  metaPath: string,
  txtPath: string,
  outDir: string,
  options: ChunkOptions,
): Promise<{ clusterId: number; chunks: number; chars: number }> {
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as MetaFile;
  const text = await fs.readFile(txtPath, 'utf8');

  const chunks: Chunk[] = chunkCluster({
    cluster_id: meta.cluster_id,
    case_name: meta.case_name,
    citations: meta.citations,
    date_filed: meta.date_filed,
    text,
    sections: meta.sections,
  }, options);

  const outPath = path.join(outDir, `${meta.cluster_id}.jsonl`);
  const lines = chunks.map((c) => JSON.stringify(c)).join('\n');
  await fs.writeFile(outPath, lines + (lines ? '\n' : ''), 'utf8');

  const totalChars = chunks.reduce((s, c) => s + c.char_count, 0);
  return { clusterId: meta.cluster_id, chunks: chunks.length, chars: totalChars };
}

function parseArgs(): { chunkSizeTokens: number | null } {
  const args = process.argv.slice(2);
  let chunkSizeTokens: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chunk-size' && args[i + 1]) {
      chunkSizeTokens = parseInt(args[i + 1]!, 10);
      i++;
    }
  }
  return { chunkSizeTokens };
}

async function main(): Promise<void> {
  const paths = ensureScotusDirs();
  const t0 = Date.now();
  const { chunkSizeTokens } = parseArgs();

  // --chunk-size is in tokens (~4 chars/token); default keeps the original layout
  // in the standard chunks/ dir, a custom size writes to chunks-<tokens>/
  const options: ChunkOptions = chunkSizeTokens
    ? {
        targetChars: chunkSizeTokens * 4,
        // Keep the original 12.5% overlap ratio (400/3200)
        overlapChars: Math.round((chunkSizeTokens * 4) / 8),
      }
    : { targetChars: TARGET_CHARS, overlapChars: OVERLAP_CHARS };

  const outDir = chunkSizeTokens
    ? path.join(path.dirname(paths.chunks), `chunks-${chunkSizeTokens}`)
    : paths.chunks;
  mkdirSync(outDir, { recursive: true });

  const metaFiles = (await fs.readdir(paths.cleaned))
    .filter((f) => f.endsWith('.meta.json'))
    .sort();

  console.log(`Chunking ${metaFiles.length} clusters...`);
  console.log(`Source:  ${paths.cleaned}`);
  console.log(`Output:  ${outDir}`);
  console.log(`Target:  ${options.targetChars} chars (~${Math.round(options.targetChars / 4)} tokens), overlap ${options.overlapChars}`);
  console.log('');

  let totalChunks = 0;
  let totalChars = 0;
  const distribution = { '1': 0, '2-3': 0, '4-7': 0, '8-15': 0, '16+': 0 };
  let zeroChunkClusters = 0;
  let maxChunks = { id: 0, count: 0 };

  for (const f of metaFiles) {
    const metaPath = path.join(paths.cleaned, f);
    const txtPath = path.join(paths.cleaned, f.replace('.meta.json', '.txt'));
    const result = await processOne(metaPath, txtPath, outDir, options);

    totalChunks += result.chunks;
    totalChars += result.chars;

    if (result.chunks === 0) zeroChunkClusters++;
    else if (result.chunks === 1) distribution['1']++;
    else if (result.chunks <= 3) distribution['2-3']++;
    else if (result.chunks <= 7) distribution['4-7']++;
    else if (result.chunks <= 15) distribution['8-15']++;
    else distribution['16+']++;

    if (result.chunks > maxChunks.count) {
      maxChunks = { id: result.clusterId, count: result.chunks };
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const avgChunks = totalChunks / metaFiles.length;
  const avgChars = totalChunks > 0 ? totalChars / totalChunks : 0;
  const avgTokens = avgChars / 4;

  console.log(`Done in ${elapsed}s`);
  console.log('');
  console.log(`Clusters processed       : ${metaFiles.length}`);
  console.log(`Clusters with 0 chunks   : ${zeroChunkClusters}`);
  console.log(`Total chunks             : ${totalChunks}`);
  console.log(`Avg chunks/cluster       : ${avgChunks.toFixed(1)}`);
  console.log(`Avg chunk size           : ${avgChars.toFixed(0)} chars (~${avgTokens.toFixed(0)} tokens)`);
  console.log(`Largest cluster          : ${maxChunks.count} chunks (id ${maxChunks.id})`);
  console.log('');
  console.log('Chunks/cluster distribution:');
  for (const [k, v] of Object.entries(distribution)) {
    console.log(`  ${k.padStart(5)}: ${v}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
