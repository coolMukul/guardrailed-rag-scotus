import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface ScotusPaths {
  root: string;
  rawClusters: string;
  rawOpinions: string;
  cleaned: string;
  chunks: string;
  manifest: string;
}

export function getDataDir(): string {
  const v = process.env.DATA_DIR?.trim();
  return v && v.length > 0 ? v : 'data';
}

export function getScotusPaths(): ScotusPaths {
  const root = path.join(getDataDir(), 'scotus');
  return {
    root,
    rawClusters: path.join(root, 'raw', 'clusters'),
    rawOpinions: path.join(root, 'raw', 'opinions'),
    cleaned: path.join(root, 'cleaned'),
    chunks: path.join(root, 'chunks'),
    manifest: path.join(root, 'manifest.json'),
  };
}

export function ensureScotusDirs(): ScotusPaths {
  const p = getScotusPaths();
  mkdirSync(p.rawClusters, { recursive: true });
  mkdirSync(p.rawOpinions, { recursive: true });
  mkdirSync(p.cleaned, { recursive: true });
  mkdirSync(p.chunks, { recursive: true });
  return p;
}
