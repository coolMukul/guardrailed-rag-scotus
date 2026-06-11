/**
 * Central configuration constants for the RAG pipeline.
 * All tunable parameters should live here to enable easy configuration management.
 * Changes to these values cascade through the system without code modifications.
 */

export const CONFIG = {
  // Embedding model configuration
  // bge-small-en-v1.5: lightweight, fast CPU inference, 384-dim output
  // Used for both chunk indexing and query embedding (same model ensures compatibility)
  embeddings: {
    modelName: 'Xenova/bge-small-en-v1.5' as const,
    vectorSize: 384,
    // Timeout for first model load (large download, but only happens once)
    modelLoadTimeoutMs: 120000, // 2 minutes
    // Timeout for each embed call after model is loaded
    embedTimeoutMs: 10000, // 10 seconds
  },

  // Vector retrieval configuration
  // Dense retrieval by default; reranking is available behind a runtime flag
  retrieval: {
    collectionName: 'scotus_opinions' as const,
    // Top-k chunks to retrieve per query
    // 8 is empirically good: enough context (2-4 chunks typical per answer)
    // but few enough to fit in single Groq call without token overload
    topK: 8,
    // Timeout for Qdrant search (should be fast, vector ops are local)
    searchTimeoutMs: 5000, // 5 seconds
  },

  // LLM generation configuration
  // Provider-agnostic: single MODEL_NAME used across Groq, Gemini, LiteLLM
  generation: {
    // Which provider to use: 'groq', 'litellm', or 'gemini'
    // Default: groq (free tier, no billing required to get started)
    provider: (process.env.LLM_PROVIDER || 'groq') as 'groq' | 'litellm' | 'gemini',
    // Single model name (each provider interprets it appropriately)
    // To use Gemini: set LLM_PROVIDER=gemini MODEL_NAME=gemini-3.1-flash-lite-preview
    // To use an OpenAI-compatible proxy: set LLM_PROVIDER=litellm MODEL_NAME=gpt-4o-mini
    modelName: process.env.MODEL_NAME || 'llama-3.3-70b-versatile',
    // Max tokens to generate per answer (prevents runaway responses)
    // Need enough for JSON structure + answer text + citations
    // Set to 2048 to ensure full response isn't truncated
    maxTokens: 2048,
    // Temperature: 0.2 for deterministic, focused answers (not creative hallucinations)
    temperature: 0.2,
    // Timeout for API call (includes network latency + inference time)
    timeoutMs: 30000, // 30 seconds
  },

  // Chunk ingestion configuration
  // Controls how we batch-load 495 chunks into Qdrant during startup
  ingest: {
    // Batch size for upsert: larger = fewer network calls, but more memory
    // Reduced to 8: WSL networking becomes unstable with larger batches
    batchSize: 8,
    // Timeout for entire ingest operation
    timeoutMs: 600000, // 10 minutes (first run might be slow with model download)
    // Data directory where chunk files live (set DATA_DIR to relocate)
    chunksDir: process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/scotus/chunks`
      : 'data/scotus/chunks',
    // TESTING: Limit number of files to ingest (null = all 495 files)
    // Set to 10 for quick test, then increase if successful
    maxFiles: process.env.INGEST_MAX_FILES ? parseInt(process.env.INGEST_MAX_FILES, 10) : null,
  },

  // API server configuration
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    // Request validation: max query length to prevent DoS / token overflow
    maxQueryLengthChars: 1000,
    // Graceful shutdown timeout: wait this long for in-flight requests to complete
    gracefulShutdownTimeoutMs: 30000,
  },

  // Input validation rules
  validation: {
    // Minimum query length (must have at least 1 character)
    minQueryLength: 1,
    // Maximum query length (prevent huge prompts that blow token budget)
    maxQueryLength: 1000,
  },

  // Langfuse observability
  // All optional: if keys not set, tracing gracefully disables
  langfuse: {
    // Base URL for self-hosted Langfuse (remapped Docker port)
    baseUrl: process.env.LANGFUSE_BASE_URL || 'http://localhost:13000',
    // Public key for authentication (optional)
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    // Secret key for authentication (optional)
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    // Whether to enable observability (can be disabled for testing)
    enabled: !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
  },

  // Groq API configuration (used when LLM_PROVIDER=groq)
  groq: {
    // API key required; no default
    apiKey: process.env.GROQ_API_KEY,
    // Free-tier rate limits are enforced client-side; see src/llm/rate-limiter.ts
  },

  // LiteLLM proxy configuration (used when LLM_PROVIDER=litellm)
  litellm: {
    // Base URL for LiteLLM proxy
    baseUrl: process.env.LITELLM_BASE_URL || 'http://localhost:8000',
    // API key for LiteLLM proxy (if required by proxy)
    apiKey: process.env.LITELLM_API_KEY,
  },

  // Google Gemini API configuration (used when LLM_PROVIDER=gemini)
  gemini: {
    // API key for Google Gemini
    apiKey: process.env.GOOGLE_API_KEY,
  },

  // Qdrant vector DB configuration
  qdrant: {
    // URL to Qdrant service
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    // Timeout for Qdrant operations (increased for large collections doing background indexing)
    operationTimeoutMs: 120000, // 120 seconds (2 minutes for collection ops)
  },
} as const;

// Environment variables that must be set at startup, per active provider.
// Only the active provider's credentials are required — running on Gemini
// must not demand a Groq key, and vice versa.
export const REQUIRED_ENV_VARS_BY_PROVIDER: Record<'groq' | 'litellm' | 'gemini', string[]> = {
  groq: ['GROQ_API_KEY'],
  gemini: ['GOOGLE_API_KEY'],
  litellm: ['LITELLM_BASE_URL'],
};
