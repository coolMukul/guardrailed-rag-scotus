/**
 * Qdrant vector database client.
 *
 * Qdrant is a vector similarity search engine. We use it to:
 * 1. Store embeddings of 495 SCOTUS opinion chunks (~30K-45K vectors)
 * 2. Search for the most similar chunks given a query embedding
 *
 * Why Qdrant?
 * - Good TypeScript SDK
 * - Docker-friendly (single image)
 * - Hybrid search (BM25) is a possible future extension
 * - Fast similarity search (HNSW indexes)
 *
 * Vector similarity: cosine distance between query and chunk vectors
 * Higher score = more semantically similar
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { embed } from './embedder.js';
import { logger } from '../logger.js';
import { TimeoutError, ServiceUnavailableError, ValidationError } from '../errors.js';
import { CONFIG } from '../config/constants.js';
import { RUNTIME } from '../config/runtime.js';

// Type-safe payload schema for Qdrant points
export interface ChunkPayload {
  chunk_id: string; // Unique identifier: "cluster_id-opinion_id-chunk_index"
  case_name: string; // Case name for display
  citation?: string; // Legal citation (e.g., "384 U.S. 436 (1966)"), normalized to undefined if null
  section: string; // Which part of opinion (majority, dissent, etc.)
  chunk_index: number; // Order within the file
  year?: number; // Decision year, normalized to undefined if null
  text: string; // Full chunk text (used in prompt generation)
}

// Search result: includes similarity score + metadata
export interface SearchResult {
  score: number; // Cosine similarity (0-1, higher = more similar)
  id: number | string; // Qdrant point ID (numeric)
  payload: ChunkPayload; // Metadata + text
}

let client: QdrantClient | null = null;

/**
 * Lazy-load Qdrant client (singleton pattern).
 * Connects to http://localhost:6333 (or QDRANT_URL env var).
 *
 * Why lazy load?
 * - Avoids connection errors at import time
 * - Can test embedder without Qdrant running
 */
function getClient(): QdrantClient {
  if (!client) {
    const url = CONFIG.qdrant.url;
    logger.debug({ action: 'qdrant_client_init', url });
    // Disable version check: server 1.12.4, client 1.18.0 (minor version diff acceptable)
    // Increase timeout to 300s (5 minutes) for large operations
    client = new QdrantClient({ url, apiKey: undefined, timeout: 300000, checkCompatibility: false });
  }
  return client;
}

/**
 * Retry transient network failures on Qdrant calls.
 *
 * The WSL2 localhost relay drops idle keep-alive sockets: when the CPU-bound
 * embedder blocks the event loop for several seconds between requests, the
 * pooled connection is dead by the next call and fetch fails with ECONNRESET.
 * A retry opens a fresh socket, so one bounded retry loop fixes the whole
 * class of failures. Non-network errors (validation, 4xx) rethrow immediately.
 */
async function withNetworkRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
      const transient = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|UND_ERR/i.test(
        `${message} ${cause}`,
      );
      lastErr = err;
      if (!transient || attempt === attempts) throw err;
      logger.warn({ action: 'qdrant_retry', label, attempt, error: message, cause });
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Create or verify the Qdrant collection exists.
 * Collection: "scotus_opinions"
 * Vector size: 384 (matches bge-small embedder output)
 * Distance metric: Cosine (standard for dense retrieval)
 */
export async function ensureCollection(): Promise<void> {
  const c = getClient();
  const collName = RUNTIME.collectionName;

  try {
    // Check if collection already exists
    const collections = await c.getCollections();
    const exists = collections.collections?.some((col) => col.name === collName);

    if (exists) {
      logger.info({
        action: 'collection_exists',
        collection: collName,
      });
      return;
    }
  } catch (err) {
    // Might fail if Qdrant is down; will be caught below
    logger.warn({
      action: 'collection_check_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Collection doesn't exist; create it
  try {
    logger.info({
      action: 'collection_create_start',
      collection: collName,
      vectorSize: CONFIG.embeddings.vectorSize,
    });

    await Promise.race([
      c.createCollection(collName, {
        vectors: {
          size: CONFIG.embeddings.vectorSize,
          distance: 'Cosine', // Standard for semantic similarity
        },
      }),
      // Timeout: if creation takes > 10 seconds, fail
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Collection creation timeout')),
          CONFIG.qdrant.operationTimeoutMs,
        ),
      ),
    ]);

    logger.info({
      action: 'collection_create_complete',
      collection: collName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({
      action: 'collection_create_failed',
      collection: collName,
      error: message,
    });

    // Distinguish timeout vs other errors
    if (message.includes('timeout')) {
      throw new TimeoutError('Qdrant', CONFIG.qdrant.operationTimeoutMs);
    }

    throw new ServiceUnavailableError('Qdrant', message);
  }
}

/**
 * Ingest chunks into Qdrant.
 *
 * Process:
 * 1. For each chunk: embed its text → 384-dim vector
 * 2. Batch into groups of 32 (network efficiency)
 * 3. Upsert (insert or update) into Qdrant
 *
 * Why batch ingest?
 * - Single HTTP call for 32 vectors vs 32 calls for 1 vector each
 * - ~30 calls for 495 chunks vs ~25K calls
 * - Memory-efficient: 32 vectors fit easily in RAM
 *
 * @param chunks Array of chunk objects (with text to embed)
 * @throws TimeoutError if operation exceeds timeout
 * @throws ServiceUnavailableError if Qdrant is unreachable
 */
export async function ingestChunks(
  chunks: {
    chunk_id: string;
    case_name: string;
    citation: string | null;
    section: string;
    year: number | null;
    text: string;
  }[],
): Promise<void> {
  if (!chunks || chunks.length === 0) {
    throw new ValidationError('Chunks array cannot be empty');
  }

  const c = getClient();
  const batchSize = CONFIG.ingest.batchSize;
  let totalEmbedded = 0;

  try {
    // Accumulator for batch
    const points: Array<{
      id: number | string;
      vector: number[];
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue; // Safety check (shouldn't happen, but TypeScript requires it)

      // Embed the chunk text
      // This is the expensive step (calls Xenova model or downloads from cache)
      const embedding = await embed(chunk.text);

      // Qdrant requires numeric IDs; convert string chunk_id to a hash
      // Simple hash: sum of character codes
      let numericId = 0;
      for (let j = 0; j < chunk.chunk_id.length; j++) {
        numericId = (numericId * 31 + chunk.chunk_id.charCodeAt(j)) >>> 0; // >>> 0 keeps it as uint32
      }

      // Build point with metadata
      points.push({
        id: numericId,
        vector: embedding,
        payload: {
          chunk_id: chunk.chunk_id, // Store original string ID in payload
          case_name: chunk.case_name,
          citation: chunk.citation || '',
          section: chunk.section,
          chunk_index: i,
          year: chunk.year || 0,
          text: chunk.text, // Include text so Groq prompt can access it without second lookup
        },
      });

      totalEmbedded++;

      // When batch is full, upsert to Qdrant
      if (points.length >= batchSize) {
        try {
          const batchStartTime = Date.now();
          const batchSize = points.length;

          logger.debug({
            action: 'ingest_upsert_start',
            pointCount: batchSize,
            totalEmbeddedSoFar: totalEmbedded,
            firstPointId: points[0]?.id,
            vectorDim: points[0]?.vector?.length,
          });

          await Promise.race([
            withNetworkRetry('upsert_batch', () =>
              c.upsert(RUNTIME.collectionName, {
                points: points as any,
                wait: false,
              }),
            ),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Upsert timeout')),
                300000, // 5 minutes - give Qdrant time to process
              ),
            ),
          ]);

          const batchElapsed = Date.now() - batchStartTime;
          logger.info({
            action: 'ingest_batch',
            batchSize,
            totalIngested: totalEmbedded,
            batchElapsedMs: batchElapsed,
            pointsPerSec: Math.round((batchSize / batchElapsed) * 1000),
            memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          });

          points.length = 0; // Clear batch
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({
            action: 'ingest_batch_failed',
            batchSize: points.length,
            error: message,
          });

          if (message.includes('timeout')) {
            throw new TimeoutError('Qdrant upsert', CONFIG.qdrant.operationTimeoutMs);
          }
          throw new ServiceUnavailableError('Qdrant', message);
        }
      }
    }

    // Flush remaining points
    if (points.length > 0) {
      try {
        await Promise.race([
          withNetworkRetry('upsert_final', () =>
            c.upsert(RUNTIME.collectionName, {
              points: points as any,
              wait: false, // Don't wait for indexing to complete (matches batch behavior)
            }),
          ),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Final upsert timeout')),
              300000, // 5 minutes - give Qdrant time to process
            ),
          ),
        ]);

        logger.info({
          action: 'ingest_batch_final',
          batchSize: points.length,
          totalIngested: totalEmbedded,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({
          action: 'ingest_final_failed',
          error: message,
        });

        if (message.includes('timeout')) {
          throw new TimeoutError('Qdrant upsert', CONFIG.qdrant.operationTimeoutMs);
        }
        throw new ServiceUnavailableError('Qdrant', message);
      }
    }
  } catch (err) {
    // Log full context for debugging
    logger.error({
      action: 'ingest_failed',
      totalEmbedded,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Search for top-k chunks most similar to the query.
 *
 * Process:
 * 1. Embed the query (same model as chunks)
 * 2. Qdrant searches for top-k similar vectors (cosine distance)
 * 3. Return chunks with similarity scores
 *
 * Why top-8?
 * - Enough context for most questions (usually 2-4 chunks per answer)
 * - Few enough to fit in Groq prompt without token overflow
 * - Tunable via the retrieval sweep tooling
 *
 * @param query User question
 * @param topK Number of chunks to return (default 8)
 * @returns Array of top-k chunks with scores
 * @throws TimeoutError if search exceeds timeout
 * @throws ServiceUnavailableError if Qdrant is unreachable
 */
export async function searchDense(
  query: string,
  topK: number = RUNTIME.topK,
): Promise<SearchResult[]> {
  if (!query || query.trim().length === 0) {
    throw new ValidationError('Query cannot be empty');
  }

  if (topK <= 0 || topK > 100) {
    throw new ValidationError('topK must be between 1 and 100', { topK });
  }

  const c = getClient();
  const startTime = Date.now();

  try {
    // Embed the query
    const queryVector = await embed(query);

    // Search Qdrant
    const results = (await Promise.race([
      withNetworkRetry('search', () =>
        c.search(RUNTIME.collectionName, {
          vector: queryVector,
          limit: topK,
          with_payload: true,
        }),
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Search timeout')),
          CONFIG.retrieval.searchTimeoutMs,
        ),
      ),
    ])) as Array<any>;

    const elapsed = Date.now() - startTime;

    // Log slow searches
    if (elapsed > 1000) {
      logger.warn({
        action: 'search_slow',
        elapsed,
        topK,
        resultCount: results?.length ?? 0,
      });
    }

    // Convert Qdrant results to our SearchResult type, normalizing null to undefined
    return (results || []).map((r: any) => {
      const payload = r.payload as ChunkPayload;
      return {
        score: r.score ?? 0,
        id: r.id,
        payload: {
          ...payload,
          citation: payload.citation ?? undefined,
        },
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logger.error({
      action: 'search_failed',
      query: query.slice(0, 50), // Log first 50 chars (don't spam logs)
      error: message,
    });

    if (message.includes('timeout')) {
      throw new TimeoutError('Qdrant search', CONFIG.retrieval.searchTimeoutMs);
    }

    throw new ServiceUnavailableError('Qdrant', message);
  }
}

/**
 * Get collection statistics (for debugging / monitoring).
 * Returns point count, indexed status, etc.
 */
export async function getCollectionInfo() {
  const c = getClient();
  return c.getCollection(RUNTIME.collectionName);
}
