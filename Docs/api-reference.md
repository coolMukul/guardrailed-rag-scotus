# HTTP API Reference

The service exposes a small HTTP surface: one endpoint to ask a question, and two
operational endpoints for configuration and readiness. The companion evaluation
harness drives the service entirely through these — it is a pure HTTP client and
never touches the vector store or language model directly.

All request and response bodies are JSON.

---

## `POST /ask`

Run a question through the full pipeline: input guardrails → retrieval →
generation → answer validation. Returns a cited answer or an explicit
abstention.

### Request

```json
{
  "query": "What did the Court hold in Loper Bright?",
  "include_diagnostics": false
}
```

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `query` | string | yes | The question. Trimmed; must be non-empty and within the configured length limit. |
| `include_diagnostics` | boolean | no | When `true`, the 200 response carries an extra `diagnostics` object. **When omitted the response is byte-for-byte identical to the base contract** — existing consumers are unaffected. |

### Response `200`

```json
{
  "answer_spans": [
    { "text": "The Court overruled Chevron deference.", "citation_ids": [0] }
  ],
  "citations": [
    {
      "chunk_id": 123,
      "case_name": "Loper Bright Enterprises v. Raimondo",
      "citation": "603 U.S. 369 (2024)",
      "section": "majority",
      "text": "…source excerpt…"
    }
  ],
  "validation_status": "valid",
  "retrieved_chunk_ids": [123, 456],
  "query": "What did the Court hold in Loper Bright?"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `answer_spans` | array | Each span is an answer sentence plus the `citation_ids` (indices into `citations`) that support it. Empty when the service abstains. |
| `citations` | array | The source chunks the answer draws on: `chunk_id`, `case_name`, `citation` (nullable), `section` (nullable), and the chunk `text`. |
| `validation_status` | string | `"valid"` when the answer passed validation; `"insufficient_evidence"` when the service abstained (no grounded answer available). |
| `retrieved_chunk_ids` | array | IDs of every chunk retrieved for context, in final retrieval order. |
| `query` | string | Echo of the query actually used (post-redaction if any PII was redacted). |

### Optional `diagnostics` block

Present only when the request set `include_diagnostics: true`. It surfaces values
the pipeline already computes, for measuring retrieval quality, latency, and cost.

```json
{
  "diagnostics": {
    "retrieved_chunks": [
      {
        "rank": 1,
        "id": 123,
        "score": 0.83,
        "case_name": "Loper Bright Enterprises v. Raimondo",
        "citation": "603 U.S. 369 (2024)",
        "section": "majority"
      }
    ],
    "timings_ms": {
      "retrieve_dense": 140,
      "retrieve_rerank": null,
      "generate": 1820,
      "validate": 640,
      "total": 2730
    },
    "usage": {
      "prompt_tokens": 2150,
      "completion_tokens": 240,
      "judge_prompt_tokens": 800,
      "judge_completion_tokens": 60,
      "guardrail_prompt_tokens": 0,
      "guardrail_completion_tokens": 0
    },
    "retry_attempts": 0,
    "config_fingerprint": "162ce3ba",
    "validation": {
      "abstained": false,
      "abstain_reason": null,
      "coverage_passed": true,
      "coverage_issues": [],
      "grounding_ran": true,
      "grounding_passed": true,
      "grounding_issues": []
    }
  }
}
```

**`retrieved_chunks`** — one entry per retrieved chunk in final order, with an
explicit 1-based `rank` and the `score` used for that ordering. Chunk `text` is
deliberately excluded to keep payloads small.

**`timings_ms`** — server-side stage timings. `retrieve_rerank` is `null` when
reranking is disabled; `total` is wall-clock for the whole request.

**`usage`** — token counts for this request only, attributed per source: the
answer generator (`prompt_*`/`completion_*`), the grounding judge (`judge_*`),
and the injection-classifier guardrail (`guardrail_*`). Regenerations triggered
by the validator are folded into the generator totals and surfaced via
`retry_attempts`.

**`config_fingerprint`** — the same stable hash `GET /meta` reports at that
moment (see below).

**`validation`** — why the answer was accepted or abstained, rather than just the
final status:

| Field | Type | Meaning |
|-------|------|---------|
| `abstained` | boolean | Whether the service declined to answer. |
| `abstain_reason` | string \| null | `null` when answered, else one of: `out_of_corpus` (a named case's own opinion was not retrieved), `generator` (the model declined), `coverage` (citation-structure check failed), `grounding` (the grounding judge rejected the spans). |
| `coverage_passed` | boolean \| null | Result of the citation-coverage gate (`null` if it did not run). |
| `coverage_issues` | string[] | Human-readable coverage problems. |
| `grounding_ran` | boolean | `false` when an earlier gate short-circuited before the grounding judge. |
| `grounding_passed` | boolean \| null | Result of the grounding judge (`null` if it did not run). |
| `grounding_issues` | array | Per-span judge verdicts: `span_index`, `text`, `entails`, `reason`. |

> Guardrail-blocked requests return the `400 GUARDRAIL_VIOLATION` error body
> (below) and carry no `diagnostics`.

---

## `GET /meta`

A snapshot of the quality-relevant configuration the pipeline is actually
running with, plus a stable fingerprint over it. Intended for regression
detection: stamp a run with the fingerprint and refuse to compare runs whose
fingerprints differ. Contains no secrets.

### Response `200`

```json
{
  "service": "scotus-rag",
  "version": "0.1.0",
  "config": {
    "provider": "…",
    "model": "…",
    "collection": "…",
    "top_k": 8,
    "rerank": false,
    "rerank_pool_k": 30,
    "comparative_diversity": true,
    "comparative_pool_k": 24,
    "comparative_sub_queries": true,
    "grounding_mode": "…",
    "corpus_scope_guard": true,
    "corpus_scope_version": "…",
    "prompt_version": "…",
    "judge_version": "…",
    "prompt_cache": false,
    "validator_retries": 1,
    "temperature": 1,
    "max_tokens": 1024,
    "guardrail_pii_enabled": true,
    "guardrail_injection_enabled": true,
    "guardrail_injection_threshold": 0.5,
    "guardrail_policy_enabled": true,
    "injection_classifier_version": "…"
  },
  "config_fingerprint": "162ce3ba",
  "corpus": {
    "collection": "…",
    "point_count": 27000
  },
  "timestamp": "2026-06-20T10:00:00Z"
}
```

- **`config_fingerprint`** — a short hash over every config value that can affect
  answer quality (model, retrieval knobs, prompt/judge/classifier versions,
  validator retries, guardrail calibration). Identical config yields an identical
  fingerprint across restarts; changing any quality-relevant value changes it.
- **`config`** is serialized from the same runtime object the pipeline reads, so
  it cannot drift from actual behavior.
- **`corpus.point_count`** lets a consumer detect re-ingestion between runs. It
  degrades to `null` if the vector store is briefly unreachable (use `/ready` as
  the outage signal).

---

## `GET /ready`

Readiness probe with real dependency checks: the vector store and the language
model are probed concurrently. The result is cached briefly, so frequent polling
costs at most a couple of model pings per minute while still flipping within one
cache interval when a dependency goes down. The language-model check is a
zero-token ping.

### Response `200` (ready) / `503` (degraded)

Both share the same shape:

```json
{
  "status": "ready",
  "checks": {
    "vector_store": { "ok": true, "latency_ms": 12 },
    "llm": { "ok": true, "latency_ms": 230 }
  },
  "timestamp": "2026-06-20T10:00:00Z"
}
```

When a check fails, `status` is `"degraded"`, the HTTP status is `503`, and the
failing check carries `ok: false` plus a generic `reason` string (vendor names
are kept out of reason strings).

---

## Error contract

Errors share a common body:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE", "timestamp": "…" }
```

The `code` is the stable, machine-readable contract — treat it as frozen.

| HTTP | `code` | Meaning |
|------|--------|---------|
| `400` | `GUARDRAIL_VIOLATION` | Input was blocked by a guardrail (PII, injection, or policy). Expected for adversarial inputs. |
| `400` | `VALIDATION_ERROR` | Malformed request (e.g. empty or non-string `query`). |
| `413` | `PAYLOAD_TOO_LARGE` | `query` exceeded the configured length limit. |
| `429` | `GROQ_RATE_LIMITED` | Upstream model rate limit. Retry with backoff; `details.retryAfterSeconds` hints how long. |
| `503` | `*_UNAVAILABLE` | A required dependency is unreachable (e.g. `VECTOR_STORE_UNAVAILABLE`). Retry after a delay. |
| `504` | `*_TIMEOUT` | A dependency operation exceeded its timeout. Likely transient; retry with backoff. |
| `500` | `INTERNAL_ERROR` | Unexpected server error. |
