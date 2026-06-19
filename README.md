# Guardrailed RAG over SCOTUS Opinions

A production-ready RAG (Retrieval-Augmented Generation) system over ~500 US Supreme Court opinions, demonstrating input guardrails, grounded citations, observability-by-design, and latency discipline.

## Overview

This project builds a complete RAG pipeline with:
- **495 SCOTUS opinion chunks** indexed in Qdrant vector database
- **Langfuse observability** for tracing every step (retrieve → generate → validate)
- **Groq LLM** for fast generation
- **FastAPI REST server** for production-ready deployment
- **CLI interface** for testing and debugging

## Quick Start

### Prerequisites

- **WSL2** (Windows Subsystem for Linux) with Ubuntu
- **Docker** running in WSL
- **Node.js 22+** in WSL (via nvm)
- **SCOTUS data**: 495 JSON-L chunk files at `C:\m\data\scotus\chunks\`
- **.env file** with required API keys:
  ```
  GROQ_API_KEY=your_groq_key
  COURTLISTENER_TOKEN=your_token
  DATA_DIR=/mnt/c/m/data
  ```

### Environment Setup

#### 1. Start Docker in WSL

```bash
wsl
sudo service docker start
```

#### 2. Start All Containers

From the project root:

```bash
cd c:\m\personalGit\guardrailed-rag-scotus
docker compose up -d
```

Verify containers are running:

```bash
docker compose ps
```

You should see 7 containers:
- `qdrant` — Vector database (port 6333)
- `langfuse-postgres`, `langfuse-clickhouse`, `langfuse-redis`, `langfuse-minio` — Observability stack
- `langfuse-worker`, `langfuse-web` — Langfuse UI (port 13000)

#### 3. Install Dependencies (first time only)

```bash
cd c:\m\personalGit\guardrailed-rag-scotus
npm install
```

**Note**: If switching between Windows and WSL, rebuild native modules:

```bash
rm -rf node_modules package-lock.json
npm install
```

## Ingesting SCOTUS Chunks

### Full Ingest (All 495 Files)

```bash
npm run ingest-qdrant
```

### Resumable Ingest with Batching

The ingest script supports two environment variables for flexible, resumable ingestion:

#### `INGEST_START_FILE_INDEX`

Start ingestion from a specific file (1-indexed). Useful for resuming after failures.

```bash
INGEST_START_FILE_INDEX=363 npm run ingest-qdrant
```

This will ingest files 363 onwards (all remaining files).

#### `INGEST_MAX_FILES`

Limit the number of files to ingest in this run. Perfect for batch processing.

```bash
INGEST_MAX_FILES=30 npm run ingest-qdrant
```

This will ingest the first 30 files.

#### Combined: Batch Ingestion Strategy

Ingest in safe batches to catch issues early:

**Batch 1** (test): 2 files
```bash
INGEST_START_FILE_INDEX=363 INGEST_MAX_FILES=2 npm run ingest-qdrant
```

**Batch 2**: 10 files
```bash
INGEST_START_FILE_INDEX=365 INGEST_MAX_FILES=10 npm run ingest-qdrant
```

**Batch 3**: 30 files
```bash
INGEST_START_FILE_INDEX=375 INGEST_MAX_FILES=30 npm run ingest-qdrant
```

**Batch 4** (remaining): 91+ files
```bash
INGEST_START_FILE_INDEX=405 npm run ingest-qdrant
```

### Checking Ingest Status

Before running the next batch, verify the last batch completed successfully:

#### Check Qdrant Point Count

```bash
wsl bash -c "curl -s http://localhost:6333/collections/scotus_opinions | grep -o '\"points_count\":[0-9]*'"
```

Example output:
```
"points_count":27268
```

Compare before/after to see how many chunks were added.

#### Check Last Processed File

Examine the ingest logs to see which file was last completed:

```bash
grep "ingest_file_complete" ingest.log | tail -1
```

Or from the most recent batch output:

```bash
grep "ingest_complete" last_batch_output.txt
```

This shows:
- Total files processed
- Total chunks ingested in that batch
- Final point count

#### Detect Partial File

If the log shows `ingest_file_start` but NO corresponding `ingest_file_complete`, the file was partially ingested:

```bash
grep "ingest_file_start\|ingest_file_complete" ingest.log | tail -5
```

If the last line is `ingest_file_start` (not `ingest_file_complete`), that file is partial and should be re-ingested:

```bash
# Retry the partial file (adjust START_FILE_INDEX)
INGEST_START_FILE_INDEX=363 INGEST_MAX_FILES=1 npm run ingest-qdrant
```

### Configuration

Edit `src/config/constants.ts` to tune:

- `ingest.batchSize` — Chunks per Qdrant upsert (default: 8, WSL-optimized)
- `ingest.chunksDir` — Path to chunk files
- `ingest.maxFiles` — Can also be set via `INGEST_MAX_FILES` env var
- `qdrant.operationTimeoutMs` — Timeout for Qdrant ops (default: 60000ms for large collections)

## Running Queries

### CLI

```bash
npm run cli -- ask "What did Miranda hold?"
```

Expected output:
```
Query: What did Miranda hold?
Retrieved 8 chunks (avg similarity: 0.87)
Answer: [LLM response with citations]
Citations validated: 3/3 chunks cited, all claims grounded
```

### REST Server

```bash
npm run server
```

Then POST to `http://localhost:3000/ask`:

```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What did Miranda hold?"}'
```

## Monitoring

### Langfuse Observability

Open http://localhost:13000 (credentials: demo@langfuse.com / demo)

View traces for each request:
- **Retrieval span** — Embedding + Qdrant search (timing, vector dims)
- **Generation span** — LLM call (tokens, latency)
- **Validation span** — Citation coverage + grounding checks

### Qdrant Collection Info

```bash
curl http://localhost:6333/collections/scotus_opinions
```

Returns:
- `points_count` — Total indexed chunks
- `indexed_vectors_count` — Vectors ready for search
- `segments_count` — Qdrant internal partitions

## Architecture

```
src/
  config/
    constants.ts          — Env-frozen defaults (read by bootstrap code)
    runtime.ts            — Mutable overrides for sweeps (read by pipeline code)
    guardrails.ts         — Guardrail thresholds and per-layer toggles
    validate.ts           — Provider-aware startup env validation
  llm/
    langchain-model.ts    — Single chat-model factory for all providers
    groq-chat.ts          — Groq model wrapped with the free-tier rate limiter
    rate-limiter.ts       — Client-side sliding-window RPM/TPM/RPD/TPD limiter
  prompts/
    generation.ts         — Citation-aware answer prompts (+ cache-friendly variant)
    judge.ts              — Grounding-judge prompts
    injection.ts          — Injection-classifier prompt
  ingest/
    chunker.ts            — Split text into fixed-size chunks
  retrieval/
    embedder.ts           — BGE-small embeddings (local CPU)
    qdrant-client.ts      — Vector search + upsert
    reranker.ts           — Cross-encoder reranking (behind a runtime flag)
    retrieve.ts           — Unified retrieval entry point (dense + optional rerank)
  guardrails/
    pii.ts                — PII detection (Presidio + regex) and redaction
    injection.ts          — LLM injection classifier
    policy.ts             — Deterministic policy checks
    pipeline.ts           — Composes the three layers
  generate/
    schema.ts             — Zod output validation
    langchain-generator.ts — Structured-output generation
  validator/
    citation-coverage.ts  — Deterministic citation checks
    grounding-judge.ts    — LLM-as-judge for entailment
    retry.ts              — Bounded retry with corrective feedback
  obs/
    langfuse.ts           — Trace wrapper (graceful degradation)
    usage.ts              — Per-call token usage accounting
  server/
    routes/ask.ts         — HTTP handler
    index.ts              — Fastify app startup
  cli/
    ask.ts                — CLI entry point
```

## Model Providers

All LLM calls — answer generation, the grounding judge, and the injection
classifier — go through one factory (`src/llm/langchain-model.ts`) that builds
a chat model for the provider selected by `LLM_PROVIDER`:

- **groq** — wrapped with a client-side rate limiter that tracks
  requests/tokens per minute and per day against the free-tier limits, so
  long eval runs pace themselves instead of hitting 429s.
- **gemini** — native schema-constrained structured output.
- **openai** — any OpenAI-compatible proxy; structured output via
  json-schema / tool calling.

Provider quirks are handled once in the factory: the temperature policy
(some model families only accept a fixed temperature) and the token-cap
policy (reasoning-capable models get no cap, because they spend tokens
thinking before emitting the answer). Structured output everywhere comes
from schema-validated generation — there is no "parse free text and hope"
path.

## Input Guardrails

Three independent layers run in parallel before retrieval
(`src/guardrails/pipeline.ts`); all must pass:

1. **PII** — Presidio (ML) merged with regex patterns; detected entities are
   redacted and only the redacted query continues through the pipeline.
2. **Injection** — an LLM classifier labels the query SAFE/UNSAFE with a
   confidence threshold (tunable via `INJECTION_THRESHOLD`).
3. **Policy** — deterministic checks: length cap, non-ASCII share, abuse
   word list.

Each layer can be disabled independently via env toggles, fails open if its
backing service is down (a guardrail outage must not take the product down),
and gets its own observability span. Measured on a 52-case adversarial set:
100% injection TPR, 0% FPR on benign controls, 90.4% overall accuracy
(`reports/guardrail-evals.json`).

## Answer Validation

Two gates run after generation (`src/validator/`):

1. **Citation coverage (deterministic, fast)** — every span must cite at
   least one chunk, and every cited chunk must actually have been retrieved.
   Catches structural failures before invoking the judge.
2. **Grounding judge (LLM, semantic)** — for each span, an LLM judges whether
   the cited chunk entails the claim. Catches the model citing the right
   chunk but misrepresenting what it says.

If grounding fails, the answer is regenerated once with corrective feedback
describing exactly which spans failed and why; if it still fails, the system
returns `insufficient_evidence` rather than an ungrounded answer. Abstention
is a feature: out-of-corpus questions are expected to end here.

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Embeddings** | Xenova/bge-small | Local CPU, no API keys, 384-dim vectors |
| **Vector DB** | Qdrant v1.12.4 | Great TS SDK, hybrid search support |
| **LLM** | Groq / Gemini / any OpenAI-compatible proxy | One model factory, swappable via env |
| **Observability** | Langfuse v3 | Industry-standard, self-hosted option |
| **Framework** | Fastify | Lightweight, structured, production-style |
| **Language** | TypeScript + Node | Production-grade typing and tooling |

## Known Issues & Workarounds

### WSL Docker Networking

If `fetch failed` errors occur during ingest:

1. Reduce batch size: `batchSize: 8` (already configured)
2. Increase timeouts: `operationTimeoutMs: 60000` (already set)
3. Restart Docker: `sudo service docker restart`

### Qdrant Background Indexing & Collection Timeouts

**Error**: When ingesting large batches, you may see:
```
collection_check_failed: This operation was aborted
collection_create_failed: Collection creation timeout
fetch failed
```

**Root Cause**: With `wait: false` on upserts, Qdrant indexes in the background. As the collection grows (20K+ chunks), Qdrant becomes slow to respond to collection checks. Large batches (30+ files) can overwhelm it.

**Solution**: Restart Qdrant to clear the background indexing queue:

```bash
docker compose restart qdrant
docker compose ps  # Verify it's healthy before retrying
```

Then retry the failed file/batch. Qdrant persists to disk, so **no data is lost**—you can resume from the last completed file.

**Prevention**: Use smaller batch sizes (2-30 files) for faster, more reliable ingestion. Larger batches (90+ files) risk timeout issues on large collections.

### Node.js Version

Requires Node.js 18+. Check with:

```bash
node --version
```

If using nvm in WSL:

```bash
nvm install 22
nvm use 22
```

## Testing

### Smoke Tests

Three fast, targeted smoke scripts cover the layers most likely to break.
Each makes only a handful of model calls and exits non-zero on failure:

```bash
# LLM layer: one structured generation + one judge call, fixed in-memory chunks
npm run smoke:llm -- --provider groq

# Guardrails: 6 fixed cases across all three layers (needs Presidio for full PII)
npm run smoke:guardrails

# Full pipeline: one in-corpus question (must answer with citations)
# and one fabricated case (must abstain). Needs Qdrant ingested.
npm run smoke:pipeline
```

All accept `--provider groq|gemini|openai` and `--model <name>` overrides.

### Manual Checks

```bash
# 1. Sample ingest
INGEST_MAX_FILES=3 npm run ingest-qdrant

# 2. Verify Qdrant
curl http://localhost:6333/collections/scotus_opinions

# 3. Test CLI
npm run cli -- ask "What did the Court hold in Loper Bright?"

# 4. Check traces in Langfuse
# Open http://localhost:13000 → Traces tab
```

### No Unit Tests (by Design)

The hand-authored evaluation sets (`evals/`) are the test suite. RAG quality depends on retrieval + generation + validation, which unit tests cannot verify. The smoke scripts above guard against regressions in the plumbing; the eval runners (`npm run eval`, `npm run eval:guardrails`, `npm run study:retrieval`) measure the quality metrics that matter.

## Learning Outcomes

After completing this project:

✅ **Input Guardrails** — PII detection, prompt injection defense, policy enforcement  
✅ **Grounded Citations** — Schema validation, LLM-as-judge, bounded-retry regeneration  
✅ **Observability** — Traces wired in from day one, visible latency per component  
✅ **Performance Discipline** — Before/after metrics, measurable optimizations

## Retrieval Configuration Study (Findings)

A configuration sweep across chunk size, ranking strategy, and prompt structure, run on a 50-question hand-authored eval set (40 in-corpus, 10 out-of-corpus abstention probes). Full details in `reports/study.md`; raw data in `reports/retrieval-study.json`.

| Chunk size | hit@8 | MRR@12 | Search p50 |
|-----------:|------:|-------:|-----------:|
| 512  | 100% | 0.926 | 17 ms |
| **800**  | **100%** | **0.965** | **15 ms** |
| 1200 | 100% | 0.963 | 14 ms |

**Key findings:**

1. **Recall is saturated on this corpus** — court opinions are distinctive documents and factual questions name their case, so hit@8 is 100% at every chunk size. Configurations are differentiated by ranking quality (MRR), where 800-token chunks win: smaller chunks fragment holdings and push the first relevant result lower.
2. **Cross-encoder reranking added no quality here** — with dense retrieval already at ceiling, the reranker could only reshuffle a correct list (MRR 0.965 → 0.954) while adding ~1.8 s/query on an idle CPU. It stays in the codebase behind a runtime flag for corpora where dense retrieval has headroom.
3. **Benchmark machine state matters** — the reranker initially measured 12–14 s/query because CPU-bound ingest was running concurrently; the clean number is 7× lower. Latency benchmarks now record machine state.
4. **Similarity scores cannot gate abstention** — top-1 score separation between in-corpus and out-of-corpus questions is only ~0.04 (an out-of-corpus question about a landmark case still scores 0.70+ against a recent opinion that merely cites it). Abstention is handled by the citation/grounding validator layer instead.
5. **Validation dominates the pipeline, not retrieval** — retrieval contributes ~15 ms to a ~5 s pipeline; the generation + judge + retry stack accounts for ~4 model calls per question. Cache-friendly prompt ordering (static prefix first, volatile chunks last) is implemented, though provider-side caching never triggered at eval-scale request rates.

**Production configuration:** 800-token chunks, top-k = 8, dense-only retrieval, reranker off.

## References

- **docker-compose.yml** — Qdrant + Langfuse infrastructure config
- **.env.example** — Required environment variables
- **CONTRIBUTING.md** — Setup and regression-testing guide
- **LICENSE** — MIT

---

**Author**: Mukul Varshney  
**Status**: Retrieval configuration study complete — recommended config documented in `reports/study.md`  
**Last Updated**: June 11, 2026
