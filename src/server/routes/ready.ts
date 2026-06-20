/**
 * GET /ready — readiness probe with real dependency checks.
 *
 * Checks the vector store (collection lookup) and the LLM provider
 * (zero-token model-listing ping) concurrently, and caches the whole result
 * for 30 seconds: polling every second still costs at most two provider
 * pings per minute, and a dependency outage flips the status within one
 * cache interval.
 *
 * 200 (ready) and 503 (degraded) share the same body shape. Reason strings
 * stay generic — vendor names never leak into consumer-facing output.
 */

import { FastifyInstance } from 'fastify';
import { getCollectionInfo } from '../../retrieval/qdrant-client.js';
import { pingLLM } from '../../llm/ping.js';
import { logger } from '../../logger.js';

interface DependencyCheck {
  ok: boolean;
  latency_ms: number;
  reason?: string;
}

interface ReadyBody {
  status: 'ready' | 'degraded';
  checks: {
    vector_store: DependencyCheck;
    llm: DependencyCheck;
  };
  timestamp: string;
}

const CACHE_TTL_MS = 30_000;

let cached: { body: ReadyBody; httpStatus: number; expiresAt: number } | null = null;

async function runCheck(probe: () => Promise<void>, failReason: string): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await probe();
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    logger.warn({
      action: 'ready_check_failed',
      reason: failReason,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, latency_ms: Date.now() - start, reason: failReason };
  }
}

export async function registerReadyRoute(app: FastifyInstance) {
  app.get('/ready', async (_request, reply) => {
    if (cached && Date.now() < cached.expiresAt) {
      return reply.status(cached.httpStatus).send(cached.body);
    }

    const [vectorStore, llm] = await Promise.all([
      runCheck(async () => {
        await getCollectionInfo();
      }, 'vector store unreachable or collection missing'),
      runCheck(() => pingLLM(), 'language model endpoint unreachable'),
    ]);

    const ready = vectorStore.ok && llm.ok;
    const body: ReadyBody = {
      status: ready ? 'ready' : 'degraded',
      checks: { vector_store: vectorStore, llm },
      // Timestamp of when the checks actually ran; cached responses repeat it
      // so consumers can tell a fresh probe from a cached one.
      timestamp: new Date().toISOString(),
    };
    const httpStatus = ready ? 200 : 503;

    cached = { body, httpStatus, expiresAt: Date.now() + CACHE_TTL_MS };
    return reply.status(httpStatus).send(body);
  });
}
