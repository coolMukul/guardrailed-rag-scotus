/**
 * Structured logging setup using pino.
 *
 * Structured logging means:
 * - Each log line is valid JSON
 * - Fields are consistent (level, timestamp, message, context)
 * - Can be parsed/aggregated by tools like DataDog, Splunk, ELK
 * - Better than: console.log("Retrieved " + count + " chunks") // unstructured
 *
 * Usage:
 *   logger.info({ action: 'ask', query: '...', duration: 123 });
 *   logger.error({ err, action: 'ask_failed' });
 */

import pino from 'pino';

// Create logger with appropriate level based on environment
// LOG_LEVEL env var can be: trace, debug, info, warn, error, fatal
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

export const logger = pino({
  level: logLevel,
  // Pretty-print in development (human-readable) vs JSON in production
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

/**
 * Create a child logger with request context.
 * All logs from this logger will include the requestId.
 *
 * Usage in request handler:
 *   const reqLogger = logger.child({ requestId });
 *   reqLogger.info({ action: 'ask_start' }); // includes requestId automatically
 */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
