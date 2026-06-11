/**
 * Ingest script: Load 495 SCOTUS opinion chunks into Qdrant.
 *
 * Process:
 * 1. Read all .jsonl files from C:\m\data\scotus\chunks\
 * 2. Parse JSON records (chunk_id, case_name, citation, section, year, text)
 * 3. Call ensureCollection() to create Qdrant collection if needed
 * 4. Batch-call ingestChunks() to embed + upsert into Qdrant
 * 5. Report final point count
 *
 * Why separate script?
 * - Ingest is a one-time operation at startup
 * - Bulk embedding can take minutes; shouldn't happen on every request
 * - Errors should fail fast (no graceful degradation)
 *
 * Usage:
 *   npm run ingest-qdrant
 *   npm run ingest-qdrant -- --collection scotus_opinions_512 --chunks-dir C:\m\data\scotus\chunks-512
 */

import 'dotenv/config'; // Load .env file before anything else
import os from 'os';
import path from 'path';
import { readFile, readdir, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { ensureCollection, ingestChunks, getCollectionInfo } from '../src/retrieval/qdrant-client.js';
import { logger } from '../src/logger.js';
import { CONFIG } from '../src/config/constants.js';
import { applyRuntimeOverrides } from '../src/config/runtime.js';
import { validateEnvironment } from '../src/config/validate.js';

// INGEST_LOCK_SUFFIX lets parallel workers (different collections or file
// ranges via INGEST_START_FILE_INDEX/INGEST_MAX_FILES) hold separate locks.
const LOCK_FILE = path.join(
  os.tmpdir(),
  `ingest-qdrant${process.env.INGEST_LOCK_SUFFIX ?? ''}.lock`,
);

// Type-safe chunk record (matches what's in C:\m\data\scotus\chunks\*.jsonl)
interface ChunkRecord {
  chunk_id: string;
  case_name: string;
  citation: string | null;
  section: string;
  year: number | null;
  text: string;
}

function parseArgs(): { collection: string | null; chunksDir: string | null } {
  const args = process.argv.slice(2);
  let collection: string | null = null;
  let chunksDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--collection' && args[i + 1]) {
      collection = args[i + 1]!;
      i++;
    } else if (args[i] === '--chunks-dir' && args[i + 1]) {
      chunksDir = args[i + 1]!;
      i++;
    }
  }
  return { collection, chunksDir };
}

async function main() {
  const cliArgs = parseArgs();
  if (cliArgs.collection) {
    applyRuntimeOverrides({ collectionName: cliArgs.collection });
  }

  // Check if another ingest is already running
  if (existsSync(LOCK_FILE)) {
    console.error('✗ Another ingest process is already running. Exiting.');
    console.error(`  Lock file: ${LOCK_FILE}`);
    console.error(`  If this is stale, delete it: rm ${LOCK_FILE}`);
    process.exit(1);
  }

  // Create lock file
  try {
    await writeFile(LOCK_FILE, process.pid.toString());
  } catch (err) {
    logger.error({
      action: 'ingest_lock_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Validate environment at startup
  validateEnvironment();

  const chunksDir = cliArgs.chunksDir || CONFIG.ingest.chunksDir;

  logger.info({
    action: 'ingest_start',
    chunksDir,
    collection: cliArgs.collection || undefined,
    processId: process.pid,
  });

  try {
    // Step 1: Create collection if needed
    await ensureCollection();

    // Step 2: List all .jsonl files
    let files: string[];
    try {
      files = await readdir(chunksDir);
    } catch (err) {
      logger.error({
        action: 'ingest_read_dir_failed',
        chunksDir,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Cannot read chunks directory: ${chunksDir}`);
    }

    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort();
    const maxFiles = CONFIG.ingest.maxFiles;
    const startFileIndex = process.env.INGEST_START_FILE_INDEX ? parseInt(process.env.INGEST_START_FILE_INDEX, 10) : 1;

    // Slice from startFileIndex-1 (0-indexed), then apply maxFiles limit if set
    let filesToProcess = jsonlFiles.slice(startFileIndex - 1);
    if (maxFiles) {
      filesToProcess = filesToProcess.slice(0, maxFiles);
    }

    logger.info({
      action: 'ingest_discovered_files',
      count: jsonlFiles.length,
      startFileIndex,
      maxFilesLimit: maxFiles,
      filesToProcess: filesToProcess.length,
    });

    if (filesToProcess.length === 0) {
      throw new Error(`No .jsonl files found in ${chunksDir}`);
    }

    let totalIngested = 0;
    let fileIndex = 0;
    const startTime = Date.now();

    // Step 3: Process each file
    for (const file of filesToProcess) {
      fileIndex++;
      const filePath = path.join(chunksDir, file);

      try {
        // Read file
        const content = await readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        // Parse JSON-L: each line is a chunk record
        const chunks: ChunkRecord[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue; // Skip empty lines

          try {
            const obj = JSON.parse(line);
            chunks.push({
              chunk_id: obj.chunk_id,
              case_name: obj.case_name,
              citation: obj.citation,
              section: obj.section,
              year: obj.year,
              text: obj.text,
            });
          } catch (parseErr) {
            logger.warn({
              action: 'ingest_parse_error',
              file,
              line: i + 1,
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            // Continue with next line instead of failing entire file
          }
        }

        if (chunks.length === 0) {
          logger.warn({
            action: 'ingest_no_chunks',
            file,
          });
          continue;
        }

        // Ingest chunks into Qdrant (calls embedder + upsert)
        try {
          const fileStartTime = Date.now();
          logger.info({
            action: 'ingest_file_start',
            file,
            fileIndex,
            totalFiles: filesToProcess.length,
            chunkCount: chunks.length,
          });

          await ingestChunks(chunks);
          totalIngested += chunks.length;

          const fileElapsed = Date.now() - fileStartTime;
          const chunksPerSec = Math.round((chunks.length / fileElapsed) * 1000);

          logger.info({
            action: 'ingest_file_complete',
            file,
            fileIndex,
            chunkCount: chunks.length,
            totalIngested,
            elapsedMs: fileElapsed,
            chunksPerSec,
            memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          });
        } catch (ingestErr) {
          logger.error({
            action: 'ingest_file_failed',
            file,
            error: ingestErr instanceof Error ? ingestErr.message : String(ingestErr),
          });
          // Don't continue: ingest errors should fail the whole operation
          throw ingestErr;
        }
      } catch (fileErr) {
        logger.error({
          action: 'ingest_read_file_failed',
          file,
          error: fileErr instanceof Error ? fileErr.message : String(fileErr),
        });
        throw fileErr;
      }
    }

    // Step 4: Verify final count
    const info = await getCollectionInfo();
    const elapsed = Date.now() - startTime;

    logger.info({
      action: 'ingest_complete',
      totalIngested,
      collectionPointCount: info.points_count,
      elapsedSeconds: Math.round(elapsed / 1000),
    });

    // Success!
    console.log(`\n✓ Ingest complete`);
    console.log(`  Files processed: ${jsonlFiles.length}`);
    console.log(`  Chunks ingested: ${totalIngested}`);
    console.log(`  Total points in Qdrant: ${info.points_count}`);
    console.log(`  Time: ${Math.round(elapsed / 1000)}s`);

    // Clean up lock file
    try {
      await unlink(LOCK_FILE);
    } catch (err) {
      logger.warn({
        action: 'ingest_lock_cleanup_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    // Log full error
    logger.error({
      action: 'ingest_failed',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    // Print user-friendly message
    console.error(`\n✗ Ingest failed: ${err instanceof Error ? err.message : String(err)}`);

    // Clean up lock file on error too
    try {
      await unlink(LOCK_FILE);
    } catch (lockErr) {
      logger.warn({
        action: 'ingest_lock_cleanup_failed_on_error',
        error: lockErr instanceof Error ? lockErr.message : String(lockErr),
      });
    }

    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({
    action: 'ingest_unhandled_error',
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
