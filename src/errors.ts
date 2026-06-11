/**
 * Custom error classes for the RAG pipeline.
 * Each error type has:
 * - A unique code (for client error handling / circuit breakers)
 * - An HTTP status (for REST responses)
 * - Details object (for structured logging / debugging)
 *
 * This lets clients distinguish "Qdrant is down" (503) from "invalid query" (400)
 * and implement appropriate recovery strategies.
 */

export class AppError extends Error {
  constructor(
    // Unique error code (e.g., 'QDRANT_TIMEOUT' or 'INVALID_QUERY')
    public code: string,
    // HTTP status to return
    public status: number,
    // Human-readable message
    message: string,
    // Additional context for logs/debugging
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Thrown when user input validation fails.
 * Status 400: client's responsibility to fix (invalid query).
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', 400, message, details);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when Groq API returns rate limit (429).
 * Status 429: client should retry after delay.
 */
export class RateLimitError extends AppError {
  constructor(retryAfterSeconds?: number) {
    super(
      'GROQ_RATE_LIMITED',
      429,
      `Groq rate limit exceeded. Retry after ${retryAfterSeconds || 60}s.`,
      { retryAfterSeconds },
    );
    this.name = 'RateLimitError';
  }
}

/**
 * Thrown when a service (Qdrant, Groq, etc.) times out.
 * Status 504: likely transient; client should retry with backoff.
 */
export class TimeoutError extends AppError {
  constructor(service: string, timeoutMs: number) {
    super(
      `${service.toUpperCase()}_TIMEOUT`,
      504,
      `${service} operation exceeded ${timeoutMs}ms timeout`,
      { service, timeoutMs },
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when a required dependency is unreachable.
 * Status 503: service degraded; client should retry after delay.
 */
export class ServiceUnavailableError extends AppError {
  constructor(service: string, reason?: string) {
    super(
      `${service.toUpperCase()}_UNAVAILABLE`,
      503,
      `${service} is unavailable${reason ? `: ${reason}` : ''}`,
      { service, reason },
    );
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Thrown when required environment variables are missing.
 * Should only happen at startup; indicates misconfiguration.
 */
export class ConfigError extends AppError {
  constructor(message: string, missing?: string[]) {
    super(
      'CONFIG_ERROR',
      500,
      message,
      { missing },
    );
    this.name = 'ConfigError';
  }
}

/**
 * Thrown when Groq API returns an error.
 * Status 502: bad gateway (upstream service error).
 */
export class UpstreamError extends AppError {
  constructor(service: string, message: string, statusCode?: number) {
    super(
      `${service.toUpperCase()}_ERROR`,
      statusCode || 502,
      `${service} error: ${message}`,
      { service, originalStatus: statusCode },
    );
    this.name = 'UpstreamError';
  }
}

/**
 * Helper to check if an error is an instance of AppError.
 * Used in error handlers to distinguish app errors from unexpected crashes.
 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
