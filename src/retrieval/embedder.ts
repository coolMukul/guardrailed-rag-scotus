/**
 * Local embedding module using Xenova/transformers.
 *
 * BGE-small-en-v1.5:
 * - Runs on CPU (no GPU needed)
 * - Produces 384-dim vectors
 * - Trained specifically for dense retrieval
 * - ~380MB model, cached after first load
 *
 * Why local embeddings?
 * - No API keys, no rate limits, no costs
 * - Deterministic (same text = same vector every time)
 * - Private (data never leaves local machine)
 *
 * Trade-off: first call is slow (~few seconds for model download + first embed)
 * but subsequent calls are fast (model cached in memory).
 */

import { pipeline, env } from '@xenova/transformers';
import { logger } from '../logger.js';
import { ValidationError, TimeoutError } from '../errors.js';
import { CONFIG } from '../config/constants.js';

// Configure Xenova to download models from Hugging Face
env.allowLocalModels = false;
env.allowRemoteModels = true;

let embedder: any = null;
let modelLoadPromise: Promise<any> | null = null;

/**
 * Load the embedding model on first call; cache in memory thereafter.
 * Handles concurrent calls safely: if two requests call getEmbedder() simultaneously,
 * only one will download the model (the other waits for the promise).
 */
async function getEmbedder() {
  // Model already loaded? Return immediately.
  if (embedder) {
    return embedder;
  }

  // Model currently loading? Wait for the promise (avoid duplicate downloads).
  if (modelLoadPromise) {
    return modelLoadPromise;
  }

  // Model not loaded and not loading: start loading.
  modelLoadPromise = (async () => {
    const startTime = Date.now();
    logger.info({
      action: 'embedder_load_start',
      model: CONFIG.embeddings.modelName,
    });

    try {
      // Download + load model from Hugging Face
      // First call: slow (~few seconds + network)
      // Subsequent calls: cached in memory
      embedder = await Promise.race([
        pipeline('feature-extraction', CONFIG.embeddings.modelName),
        // Timeout: if model load takes > 2 minutes, fail
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Model load timeout')),
            CONFIG.embeddings.modelLoadTimeoutMs,
          ),
        ),
      ]);

      const elapsed = Date.now() - startTime;
      logger.info({
        action: 'embedder_load_complete',
        elapsed,
        model: CONFIG.embeddings.modelName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        action: 'embedder_load_failed',
        error: message,
        model: CONFIG.embeddings.modelName,
      });
      throw err;
    }

    return embedder;
  })();

  return modelLoadPromise;
}

/**
 * Embed text into a 384-dimensional vector.
 * Uses mean pooling + L2 normalization for consistent similarity scoring.
 *
 * @param text The text to embed (non-empty string)
 * @returns 384-dimensional number array (normalized cosine vectors)
 * @throws ValidationError if text is empty
 * @throws TimeoutError if embedding takes too long
 * @throws Error if embedding fails
 */
export async function embed(text: string): Promise<number[]> {
  // Validate input: must be non-empty string
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new ValidationError('Text to embed cannot be empty', { textLength: text?.length });
  }

  try {
    const startTime = Date.now();

    // Load model (or wait for existing load)
    const extractor = await getEmbedder();

    // Embed with timeout: if this takes > 10 seconds, fail
    const output = await Promise.race([
      extractor(text, {
        pooling: 'mean', // Average the token embeddings
        normalize: true, // L2 normalize for cosine similarity
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Embed timeout')),
          CONFIG.embeddings.embedTimeoutMs,
        ),
      ),
    ]);

    const elapsed = Date.now() - startTime;

    // Extract embedding from output
    // Xenova returns a Tensor object; we need to convert it to an array
    let embedding: number[];

    if (output && typeof output === 'object') {
      // Xenova returns a Tensor object with { dims, type, data, size }
      // Extract the numeric array from the data property
      if ('data' in output && output.data && typeof output.data === 'object') {
        // output.data is the raw TypedArray or array-like object
        embedding = Array.from(output.data);
      } else if (Array.isArray(output)) {
        // Fallback: if output itself is an array
        embedding = Array.from(output);
      } else {
        throw new Error(
          `Unexpected output format. Expected Tensor with 'data' property. ` +
          `Got properties: ${Object.keys(output).join(', ')}`,
        );
      }
    } else {
      throw new Error(
        `Unexpected embedding output: expected object, got ${typeof output}`,
      );
    }

    // Validate output length
    if (!Array.isArray(embedding) || embedding.length !== CONFIG.embeddings.vectorSize) {
      throw new Error(
        `Unexpected embedding dimension: expected ${CONFIG.embeddings.vectorSize}, ` +
        `got ${embedding.length}`,
      );
    }

    // Log successful embedding (useful for performance monitoring)
    if (elapsed > 1000) {
      logger.warn({
        action: 'embed_slow',
        elapsed,
        textLength: text.length,
      });
    }

    return embedding;
  } catch (err) {
    // Categorize errors for better debugging
    if (err instanceof TimeoutError) {
      throw err;
    }

    if (err instanceof ValidationError) {
      throw err;
    }

    // Generic embedding error: wrap with context
    const message = err instanceof Error ? err.message : String(err);
    logger.error({
      action: 'embed_failed',
      error: message,
      textLength: text.length,
    });

    throw new Error(`Failed to embed text: ${message}`);
  }
}
