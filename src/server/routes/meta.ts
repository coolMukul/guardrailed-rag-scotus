/**
 * GET /meta — configuration snapshot for the eval harness.
 *
 * Returns the quality-relevant config the pipeline is actually running with,
 * plus a stable fingerprint over it. The eval harness stamps each run with
 * the fingerprint and refuses to compare runs whose fingerprints differ, so
 * a config change between runs is detected up front instead of surfacing as
 * a confusing regression report.
 *
 * Config values are serialized from RUNTIME/CONFIG via getQualityConfig() —
 * the same objects the pipeline reads — so this snapshot cannot drift from
 * actual behavior. No secrets: keys and connection strings never appear here.
 */

import { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { RUNTIME } from '../../config/runtime.js';
import { getQualityConfig, computeConfigFingerprint } from '../../config/fingerprint.js';
import { getCollectionInfo } from '../../retrieval/qdrant-client.js';
import { logger } from '../../logger.js';

const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string };

export async function registerMetaRoute(app: FastifyInstance) {
  app.get('/meta', async (_request, reply) => {
    // Corpus size detects re-ingestion between eval runs. A vector-store
    // outage shouldn't make config unreadable, so failure degrades to null
    // rather than failing the whole endpoint (/ready is the outage signal).
    let pointCount: number | null = null;
    try {
      const info = await getCollectionInfo();
      pointCount = info.points_count ?? null;
    } catch (err) {
      logger.warn({
        action: 'meta_collection_info_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return reply.send({
      service: 'scotus-rag',
      version: pkg.version,
      config: getQualityConfig(),
      config_fingerprint: computeConfigFingerprint(),
      corpus: {
        collection: RUNTIME.collectionName,
        point_count: pointCount,
      },
      timestamp: new Date().toISOString(),
    });
  });
}
