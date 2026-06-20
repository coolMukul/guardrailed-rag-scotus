# Pipeline Overview

This document walks the end-to-end data flow of a single question: how a query
becomes an embedding, finds relevant opinions, and produces a grounded answer —
and how every step is observable. Input guardrails and output validation are
covered in their own documents ([input-guardrails.md](input-guardrails.md),
[answer-validation.md](answer-validation.md)); here we focus on retrieval,
generation, and observability.

## The problem

There are ~500 US Supreme Court opinions in the corpus. A user asks a question.
The system must:

1. Find the relevant opinions (**retrieval**)
2. Generate an answer grounded *only* in those opinions (**generation**)
3. Make every step inspectable — timing and tokens (**observability**)

## Data flow

### Query → embedding

**Code:** [src/retrieval/embedder.ts](../src/retrieval/embedder.ts)

The first call loads `bge-small-en-v1.5` (via `@xenova/transformers`) and caches
it. Text is converted to a 384-dimensional vector; cosine distance between two
such vectors approximates semantic relevance.

Why this model:

- Small enough for fast CPU inference — no GPU, no API key, no outbound call.
- 384 dimensions is compact compared with 768+ from larger models.
- BGE is trained specifically for dense retrieval.

The same function embeds chunks at ingest time and queries at search time. They
must go through the identical path or the vectors are not comparable.

### Chunks → vector store

**Code:** [src/retrieval/qdrant-client.ts](../src/retrieval/qdrant-client.ts),
[scripts/ingest-qdrant.ts](../scripts/ingest-qdrant.ts)

Ingestion ensures the `scotus_opinions` collection exists (vector size 384,
cosine distance) and upserts each chunk with its payload —
`{ chunk_id, case_name, citation, section, year, text }`. Upserts are batched
(default `batchSize: 8`, tuned for the WSL networking path; see
`src/config/constants.ts`) so it is one HTTP round-trip per batch rather than
per vector.

The original chunk text rides along in the payload. That avoids a second lookup
at generation time (the prompt needs the text) and lets traces show exactly what
was retrieved.

### Query → search → top-k

**Code:** [src/retrieval/retrieve.ts](../src/retrieval/retrieve.ts),
[src/retrieval/qdrant-client.ts](../src/retrieval/qdrant-client.ts)

The query vector is compared against every chunk vector; Qdrant returns the
top-k by cosine similarity with their payloads and scores. Production uses
**k = 8, dense-only** — enough context to answer, few enough to fit a single
generation call. A cross-encoder reranker exists
([src/retrieval/reranker.ts](../src/retrieval/reranker.ts)) behind a runtime
flag; the retrieval study found it added no quality on this corpus (dense
retrieval is already at ceiling), so it is off by default. See
[`reports/study.md`](../reports/study.md).

**Comparative questions get special handling.** A question that compares two
cases ("how do X and Y differ") needs *both* in context, but a single combined
query vector leans toward one case and can starve the other below the cutoff. For
these, retrieval (a) runs a dense **sub-query per named case** so each is fetched
on its own vector, merges those pools with the combined-query pool, and (b)
selects the final eight with **diversity across `case_name`** — round-robin so
every case contributes its best chunk before any case contributes a second. The
result is that both cases reliably make the top-k. Ordinary single-case queries
are unaffected.

### Chunks + question → answer

**Code:** [src/generate/langchain-generator.ts](../src/generate/langchain-generator.ts),
[src/prompts/generation.ts](../src/prompts/generation.ts),
[src/generate/schema.ts](../src/generate/schema.ts)

The prompt is assembled from a system instruction, the retrieved chunks (each
tagged with an explicit index), and the user question. Generation does **not**
return free text — it returns structured output validated against a Zod schema
(`answer_spans` with `citation_ids`, plus a `citations` list). Invalid output is
caught at the boundary and retried rather than parsed-and-hoped.

All model calls — generation, the grounding judge, and the injection classifier
— go through one factory, [src/llm/langchain-model.ts](../src/llm/langchain-model.ts),
which builds a chat model for the provider named by `LLM_PROVIDER` (`groq`,
`gemini`, or any OpenAI-compatible proxy via `openai`). Provider quirks —
fixed-temperature model families, token-cap policy for reasoning models — are
handled once, there.

## Observability

**Code:** [src/obs/langfuse.ts](../src/obs/langfuse.ts),
[src/obs/usage.ts](../src/obs/usage.ts), wired through
[src/server/routes/ask.ts](../src/server/routes/ask.ts)

Each request opens a trace; each stage opens a span — retrieval, generation,
guardrails, validation — recording latency and token counts. This is
built in from the start, not retrofitted: you cannot optimize what you do not
measure, and the retrieval configuration study depends on these numbers existing.

Tracing degrades gracefully. If the Langfuse keys are unset or the backend is
down, the tracer becomes a no-op and requests still succeed. Observability is
hygiene, never a hard dependency.

## Request flow, end to end

```
POST /ask { "query": "What did Miranda hold?" }
│
├─ [trace: ask]
│  ├─ [span: guardrails]   PII / injection / policy (parallel) → redacted query
│  ├─ [span: retrieve]     embed(query) → Qdrant search(k=8, comparative-aware) → chunks
│  ├─ corpus-scope guard   named case not in retrieved set? → insufficient_evidence
│  ├─ [span: generate]     structured-output call → answer_spans + citations (+ abstained)
│  ├─ [span: validate]     coverage → grounding judge → (retry once) → per-span salvage
│  └─ upload trace
│
└─ response: { answer_spans, citations, validation_status, retrieved_chunk_ids }
```

## Design decisions

**Dense-only retrieval.** One signal (cosine similarity) is simpler to reason
about and debug than two (BM25 + dense). The study confirmed recall is saturated
on this corpus, so a second signal buys nothing here.

**Structured output over free text.** Citations have to be machine-checkable for
the validator to work. A schema makes invalid output impossible to process
silently and lets the type flow through the whole validation path.

**Text in the payload.** Storage is cheap; a second disk/Qdrant lookup at
generation time is not. Keeping the text with the vector also makes traces
self-explanatory.

**Provider behind one factory.** Swapping `groq` for `gemini` or a proxy is an
env change, not a code change. Rate limiting, temperature policy, and token caps
live in the factory so no caller has to know them.

## Key files

| Question | File |
|----------|------|
| How is text turned into vectors? | [src/retrieval/embedder.ts](../src/retrieval/embedder.ts) |
| How does Qdrant store and search? | [src/retrieval/qdrant-client.ts](../src/retrieval/qdrant-client.ts) |
| Where does retrieval get composed? | [src/retrieval/retrieve.ts](../src/retrieval/retrieve.ts) |
| How is a model chosen and called? | [src/llm/langchain-model.ts](../src/llm/langchain-model.ts) |
| How is the answer structured? | [src/generate/schema.ts](../src/generate/schema.ts) |
| How is a request traced? | [src/obs/langfuse.ts](../src/obs/langfuse.ts) |
| What does the `/ask` endpoint do? | [src/server/routes/ask.ts](../src/server/routes/ask.ts) |
