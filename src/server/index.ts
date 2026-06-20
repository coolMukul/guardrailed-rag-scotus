/**
 * Fastify server setup and startup.
 *
 * Exports:
 * - createServer(): Creates (but doesn't start) the Fastify app
 * - start(): Creates + starts the server, handles graceful shutdown
 *
 * Routes:
 * - GET /health — liveness probe (always returns 200)
 * - GET /ready — readiness probe (checks dependencies; 503 if not ready)
 * - GET /meta — config snapshot + fingerprint (eval harness contract)
 * - POST /ask — main RAG endpoint
 */

import 'dotenv/config'; // Load .env file before anything else
import { pathToFileURL } from 'node:url';
import Fastify, { FastifyInstance } from 'fastify';
import { registerAskRoute } from './routes/ask.js';
import { registerReadyRoute } from './routes/ready.js';
import { registerMetaRoute } from './routes/meta.js';
import { logger } from '../logger.js';
import { CONFIG } from '../config/constants.js';
import { validateEnvironment } from '../config/validate.js';

/**
 * Create a Fastify app with routes.
 * Does NOT start listening; call app.listen() to start.
 *
 * @returns Fastify instance with registered routes
 */
export async function createServer(): Promise<FastifyInstance> {
  // Create Fastify with structured logging
  const app = Fastify({
    requestTimeout: 60000, // 60s timeout for requests (includes embedding + retrieval + generation)
  });

  // Liveness probe: is the process alive?
  // Used by Kubernetes / Docker health checks
  // Returns 200 if the process is responsive (even if dependencies are down)
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Readiness probe: are all dependencies healthy?
  // Returns 200 if ready to accept requests, 503 if degraded
  await registerReadyRoute(app);

  // Config snapshot + fingerprint for eval-run regression detection
  await registerMetaRoute(app);

  // Register application routes
  await registerAskRoute(app);

  return app;
}

/**
 * Create + start the server.
 * Handles startup errors and graceful shutdown on SIGTERM.
 */
export async function start() {
  // Validate environment before starting
  validateEnvironment();

  logger.info({ action: 'server_start' });

  const app = await createServer();
  const port = CONFIG.server.port;
  const host = CONFIG.server.host;

  try {
    // Start listening
    await app.listen({ port, host });
    logger.info({
      action: 'server_listening',
      host,
      port,
      url: `http://${host}:${port}`,
    });

    // User-friendly message
    console.log(`\n✓ Server listening on http://${host}:${port}`);
    console.log(`  GET  /health  — Liveness probe`);
    console.log(`  GET  /ready   — Readiness probe (dependency checks)`);
    console.log(`  GET  /meta    — Config snapshot + fingerprint`);
    console.log(`  POST /ask     — RAG endpoint\n`);
  } catch (err) {
    // Startup failed: log and exit
    logger.error({
      action: 'server_start_failed',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    console.error(`\n✗ Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Graceful shutdown: handle SIGTERM (e.g., from Kubernetes)
  // Stop accepting new requests, wait for in-flight requests to complete.
  // The force-exit timer is armed only once shutdown begins — arming it at
  // startup would kill a healthy server after the timeout elapsed.
  process.on('SIGTERM', async () => {
    logger.info({ action: 'sigterm_received' });

    const forceExit = setTimeout(() => {
      logger.error({
        action: 'shutdown_timeout',
        timeoutMs: CONFIG.server.gracefulShutdownTimeoutMs,
      });
      process.exit(1);
    }, CONFIG.server.gracefulShutdownTimeoutMs);

    try {
      // Close HTTP server (stop accepting new requests)
      await app.close();
      clearTimeout(forceExit);
      logger.info({ action: 'shutdown_complete' });
      process.exit(0);
    } catch (err) {
      logger.error({
        action: 'shutdown_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });
}

/**
 * Entry point: if this script is run directly, start the server.
 * (Not run when imported as a module.)
 * pathToFileURL handles Windows paths — naive `file://${argv[1]}` string
 * interpolation never matches on Windows (backslashes, drive letter), which
 * silently made direct runs a no-op.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    logger.error({
      action: 'startup_unhandled_error',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
