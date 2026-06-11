# Contributing

This is a learning-oriented reference implementation of a guardrailed RAG
pipeline. Contributions that improve clarity, correctness, or the evaluation
tooling are welcome.

## Setup

1. **Infrastructure** — Docker Compose runs Qdrant, Langfuse, and Presidio:

   ```bash
   docker compose up -d
   ```

2. **Node** — Node.js 22+ (`nvm install 22 && nvm use 22`).

3. **Environment** — copy `.env.example` to `.env` and fill in the key for
   your chosen provider (`LLM_PROVIDER`).

4. **Data** — download, chunk, and ingest the corpus:

   ```bash
   npm run ingest        # fetch opinions (needs COURTLISTENER_TOKEN)
   npm run chunk         # split into chunks
   npm run ingest-qdrant # index into Qdrant
   ```

## Testing changes

There are deliberately no unit tests — the eval sets are the regression gate
(see README, "No Unit Tests (by Design)").

For quick feedback while developing, run the smoke scripts (seconds, a
handful of model calls):

```bash
npm run typecheck
npm run smoke:llm -- --provider groq
npm run smoke:guardrails
npm run smoke:pipeline
```

Before submitting a change that could affect quality, run the relevant eval
and compare against the committed baselines in `reports/`:

```bash
npm run eval:guardrails   # vs reports/guardrail-evals.json
npm run study:retrieval   # vs reports/retrieval-study.json (zero LLM cost)
npm run eval -- --limit 10  # spot-check generation + validation metrics
```

A regression of more than ~2% on any baseline metric needs an explanation in
the PR description.
