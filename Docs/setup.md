# Setup

A complete local setup: infrastructure, environment, corpus, and how to verify
the system works end to end. The top-level [README](../README.md) has the
condensed quick-start; this is the full walkthrough with troubleshooting and a
configuration reference.

## Prerequisites

- **Node.js 22+** — `nvm install 22 && nvm use 22`.
- **Docker** (with Compose) — runs the vector store, observability stack, and
  PII analyzer.
- **An LLM provider key** — one of: a Groq key (the default), a
  Google Gemini key, or the base URL of any OpenAI-compatible proxy.
- **A CourtListener token** *(only to build the corpus from scratch)* — from
  <https://www.courtlistener.com>.

Install dependencies:

```bash
npm install
```

## 1. Infrastructure

```bash
docker compose up -d
```

This brings up the following services (all ports remapped from defaults so they
do not collide with anything else on the host):

| Service | Purpose | Host port |
|---------|---------|-----------|
| `qdrant` | Vector store | 6333 (REST), 6334 (gRPC) |
| `langfuse-web` | Observability UI | 13000 |
| `presidio-analyzer` | PII entity detection | 5001 |
| `langfuse-postgres` / `-clickhouse` / `-redis` / `-minio` / `-worker` | Langfuse backing services | 15432 / 18123·19000 / 16379 / 19090·19091 / — |

Give the stack ~30s to stabilize, then check health:

```bash
curl http://localhost:6333                   # Qdrant — returns service/version info
curl http://localhost:5001/health            # Presidio
# Langfuse UI: open http://localhost:13000
```

> The Compose secrets are intentionally weak and committed — they are for local
> development only. Never reuse them anywhere else.

## 2. Environment

Copy the template and fill in the values for your chosen provider:

```bash
cp .env.example .env
```

Pick a provider with `LLM_PROVIDER` and set the matching credential:

| `LLM_PROVIDER` | Required | Typical `MODEL_NAME` |
|----------------|----------|----------------------|
| `groq` *(default)* | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `gemini` | `GOOGLE_API_KEY` | `gemini-3.1-flash-lite-preview` |
| `openai` | `LLM_BASE_URL` (+ `LLM_API_KEY` if the proxy needs one) | `gpt-4o-mini` or whatever your proxy exposes |

Only the active provider's credential is required at startup — running on Gemini
does not demand a Groq key, and vice versa.

**Observability (optional).** Tracing degrades gracefully: if the Langfuse keys
are unset, requests still succeed with no traces. To enable it, sign up at
<http://localhost:13000>, create a project, and copy its keys into `.env`:

```
LANGFUSE_BASE_URL=http://localhost:13000
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
```

## 3. Build and index the corpus

If you already have chunk files, set `DATA_DIR` to point at them and skip to the
last step. To build from scratch:

```bash
npm run ingest         # download opinions from CourtListener (needs COURTLISTENER_TOKEN)
npm run chunk          # clean + split opinions into chunks
npm run ingest-qdrant  # embed each chunk and index into Qdrant
```

`ingest-qdrant` downloads the embedding model on first run (~380 MB, one-time)
and then upserts every chunk into the `scotus_opinions` collection. For a quick
sample instead of the full corpus, cap the run:

```bash
INGEST_MAX_FILES=3 npm run ingest-qdrant
```

See the README's "Ingesting SCOTUS Chunks" section for resumable/batched
ingestion of the full corpus.

Confirm the collection populated:

```bash
curl http://localhost:6333/collections/scotus_opinions
# look for a non-zero "points_count"
```

## 4. Run it

**CLI:**

```bash
npm run cli -- ask "What did the majority hold in Miranda v. Arizona?"
```

**Server:**

```bash
npm run server   # listens on http://localhost:3000 (override with PORT / HOST)
```

```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What was decided in Marbury v. Madison?"}'
```

## Running as a System Under Test

This service is consumed by a separate evaluation-harness project,
**`evals-harness-scotus`**, which drives it as the System Under Test (SUT). The
harness does not import this code — it talks to the running server over HTTP,
sending questions to the `/ask` endpoint and scoring the responses.

So before running the harness, this service must be up:

1. Bring up infrastructure and ingest the corpus (steps 1–3 above).
2. Start the server: `npm run server` (default `http://localhost:3000`).
3. Point the harness at it via its own `SCOTUS_RAG_URL` (its default is
   `http://localhost:3000`; set it to match this server's `PORT` if you have
   overridden it).

Keep the server running for the duration of a harness run.

## 5. Verify

Typecheck, then run the smoke scripts — each makes only a handful of model calls
and exits non-zero on failure:

```bash
npm run typecheck
npm run smoke:llm -- --provider groq   # one structured generation + one judge call
npm run smoke:guardrails               # all three guardrail layers (needs Presidio for full PII)
npm run smoke:pipeline                 # one in-corpus question + one abstention case (needs Qdrant ingested)
```

If Langfuse is enabled, open <http://localhost:13000> → **Traces** and confirm
each request shows spans for guardrails, retrieval, generation, and validation,
with token counts and latency.

## Troubleshooting

**Qdrant connection fails.** Confirm the container is up (`docker compose ps`)
and `QDRANT_URL` matches (default `http://localhost:6333`). On Windows/WSL the
loopback address is sometimes more reliable as `127.0.0.1`.

**Embedding model download is slow / fails.** The first ingest pulls ~380 MB
from Hugging Face and needs network access. It is cached afterward.

**Provider auth errors.** Verify the credential for your active `LLM_PROVIDER`
is set. For `openai`, the failure is usually a missing or mis-typed
`LLM_BASE_URL`.

**PII layer not catching names.** Full PII detection needs the Presidio
container (`http://localhost:5001`). If it is down the layer fails open (allows
the query) and logs a warning — set `PRESIDIO_URL` if you run it elsewhere.

**No Langfuse traces.** Tracing is optional and silently disabled when the keys
are unset. Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to enable it.

## Configuration reference

All variables live in [`.env.example`](../.env.example); the loaded defaults are
in [`src/config/constants.ts`](../src/config/constants.ts).

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `groq` | Active provider: `groq` \| `gemini` \| `openai` |
| `MODEL_NAME` | `llama-3.3-70b-versatile` | Model name, interpreted per provider |
| `GROQ_API_KEY` | — | Credential when provider is `groq` |
| `GOOGLE_API_KEY` | — | Credential when provider is `gemini` |
| `LLM_BASE_URL` / `LLM_API_KEY` | `http://localhost:8000` / — | OpenAI-compatible proxy endpoint and key |
| `COURTLISTENER_TOKEN` | — | Required only for `npm run ingest` |
| `DATA_DIR` | `./data` | Where opinions and chunks live |
| `INGEST_MAX_FILES` | *(all)* | Cap files per ingest run |
| `QDRANT_URL` | `http://localhost:6333` | Vector store endpoint |
| `PRESIDIO_URL` | `http://localhost:5001` | PII analyzer endpoint |
| `LANGFUSE_BASE_URL` / `_PUBLIC_KEY` / `_SECRET_KEY` | `http://localhost:13000` / — / — | Observability (optional) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server bind |
| `INJECTION_THRESHOLD` | `0.7` | Confidence above which a query is flagged as injection |
| `GUARDRAILS_PII_ENABLED` / `_INJECTION_ENABLED` / `_POLICY_ENABLED` | `true` | Toggle each guardrail layer |
| `POLICY_MAX_LENGTH` / `POLICY_MAX_NON_ASCII_PERCENT` | `5000` / `50` | Policy-layer limits |

## Next

- [pipeline-overview.md](pipeline-overview.md) — how a query flows through the system
- [input-guardrails.md](input-guardrails.md) — the three input-defense layers
- [answer-validation.md](answer-validation.md) — citation coverage and grounding
- [evaluation-harness.md](evaluation-harness.md) — how quality is measured
