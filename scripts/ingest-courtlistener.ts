import 'dotenv/config';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  listSCOTUSClusters,
  getOpinion,
  extractIdFromUri,
  type CourtListenerCluster,
  type CourtListenerOpinion,
} from '../src/ingest/courtlistener-client.js';
import { cleanCluster } from '../src/ingest/cleaner.js';
import { ensureScotusDirs } from '../src/config/paths.js';

const PAGE_SIZE = 50;
const MIN_CLEANED_CHARS = 200;

interface Manifest {
  fetched_at: string;
  last_run_count: number;
  total_count: number;
  cluster_ids: number[];
}

async function readJsonFile<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, 'utf8')) as T;
}

async function writeJsonFile(p: string, data: unknown): Promise<void> {
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}

async function ensureClusterFile(
  cluster: CourtListenerCluster,
  dir: string,
): Promise<CourtListenerCluster> {
  const fp = path.join(dir, `${cluster.id}.json`);
  if (existsSync(fp)) return readJsonFile<CourtListenerCluster>(fp);
  await writeJsonFile(fp, cluster);
  return cluster;
}

async function ensureOpinionFile(
  id: number,
  dir: string,
): Promise<CourtListenerOpinion> {
  const fp = path.join(dir, `${id}.json`);
  if (existsSync(fp)) return readJsonFile<CourtListenerOpinion>(fp);
  const op = await getOpinion(id);
  await writeJsonFile(fp, op);
  return op;
}

async function processCluster(
  cluster: CourtListenerCluster,
  paths: ReturnType<typeof ensureScotusDirs>,
  index: number,
  target: number,
): Promise<boolean> {
  const prefix = `[${index}/${target}]`;
  const id = cluster.id;

  try {
    const stored = await ensureClusterFile(cluster, paths.rawClusters);

    const opinions: CourtListenerOpinion[] = [];
    for (const uri of stored.sub_opinions ?? []) {
      const opId = extractIdFromUri(uri);
      opinions.push(await ensureOpinionFile(opId, paths.rawOpinions));
    }

    if (opinions.length === 0) {
      console.warn(
        `${prefix} skip ${id} "${stored.case_name}" — no sub_opinions`,
      );
      return false;
    }

    const { text, sections } = cleanCluster(opinions);
    if (text.length < MIN_CLEANED_CHARS) {
      console.warn(
        `${prefix} skip ${id} "${stored.case_name}" — cleaned text only ${text.length} chars`,
      );
      return false;
    }

    const meta = {
      cluster_id: stored.id,
      case_name: stored.case_name,
      case_name_short: stored.case_name_short,
      case_name_full: stored.case_name_full,
      citations: stored.citations,
      date_filed: stored.date_filed,
      docket_id: stored.docket_id,
      opinions: opinions.map((o) => ({
        id: o.id,
        type: o.type,
        author: o.author_str,
      })),
      sections,
      text_length: text.length,
      fetched_at: new Date().toISOString(),
    };

    await fs.writeFile(path.join(paths.cleaned, `${id}.txt`), text, 'utf8');
    await writeJsonFile(path.join(paths.cleaned, `${id}.meta.json`), meta);

    const summary = sections
      .map((s) => `${s.label}:${s.text_length}`)
      .join(' ');
    console.log(
      `${prefix} ok   ${id} "${stored.case_name}" ${stored.date_filed ?? '?'} [${summary}]`,
    );
    return true;
  } catch (err) {
    console.error(`${prefix} FAIL ${id}: ${(err as Error).message}`);
    return false;
  }
}

async function loadPriorManifest(manifestPath: string): Promise<number[]> {
  if (!existsSync(manifestPath)) return [];
  try {
    const m = await readJsonFile<Partial<Manifest>>(manifestPath);
    return Array.isArray(m.cluster_ids) ? m.cluster_ids : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const target = Number(process.argv[2] ?? '10');
  if (!Number.isFinite(target) || target <= 0) {
    console.error(
      'Usage: npm run ingest -- <count>   (e.g. 3 for smoke, 500 for full)',
    );
    process.exit(1);
  }

  if (!process.env.COURTLISTENER_TOKEN?.trim()) {
    console.error('COURTLISTENER_TOKEN not set. Add it to .env.');
    process.exit(1);
  }

  const paths = ensureScotusDirs();
  console.log(`Target:       ${target} clusters`);
  console.log(`Data root:    ${paths.root}`);
  console.log('');

  const started = Date.now();
  const ingested: number[] = [];
  let page = 1;
  let index = 0;

  while (ingested.length < target) {
    const pageData = await listSCOTUSClusters(page, PAGE_SIZE);
    if (pageData.results.length === 0) break;

    for (const cluster of pageData.results) {
      if (ingested.length >= target) break;
      index++;
      const ok = await processCluster(cluster, paths, index, target);
      if (ok) ingested.push(cluster.id);
    }

    if (!pageData.next) break;
    page++;
  }

  const prior = await loadPriorManifest(paths.manifest);
  const merged = Array.from(new Set([...prior, ...ingested]));

  const manifest: Manifest = {
    fetched_at: new Date().toISOString(),
    last_run_count: ingested.length,
    total_count: merged.length,
    cluster_ids: merged,
  };
  await writeJsonFile(paths.manifest, manifest);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(
    `Done: ${ingested.length} clusters this run, ${merged.length} total in manifest. ${elapsed}s elapsed.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
