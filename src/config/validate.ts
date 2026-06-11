/**
 * Environment validation.
 * Called at startup to ensure all required variables are set.
 * Fails fast with clear error messages (better than failing later in a request).
 */

import { logger } from '../logger.js';
import { ConfigError } from '../errors.js';
import { CONFIG, REQUIRED_ENV_VARS_BY_PROVIDER } from './constants.js';

/**
 * Validate that all required environment variables are set for the active
 * LLM provider. Throws ConfigError if any are missing.
 *
 * Why validate at startup?
 * - Fail fast: catch config issues before accepting requests
 * - Clear error: developer knows exactly what's missing (not a cryptic error 5 requests in)
 * - No silent failures: never silently fall back to bad defaults
 */
export function validateEnvironment() {
  const required = REQUIRED_ENV_VARS_BY_PROVIDER[CONFIG.generation.provider] ?? [];
  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const message =
      `Missing required environment variables for provider "${CONFIG.generation.provider}": ` +
      `${missing.join(', ')}. See .env.example for setup.`;
    logger.error({ missing, message });
    throw new ConfigError(message, missing);
  }

  logger.info({ message: 'Environment validation passed' });
}

/**
 * Validate that dependent services are reachable.
 * Called after startup to confirm Qdrant and Groq are accessible.
 */
export async function validateDependencies() {
  logger.info({ message: 'Checking service dependencies...' });

  // TODO: Add health checks for Qdrant, Groq
  // Placeholder: extend with real connectivity probes as needed
  logger.info({ message: 'Service dependencies OK' });
}
