# Design Notes

Deep-dive documentation for the guardrailed RAG system. These complement the
top-level [README](../README.md), which covers setup, configuration, and the
retrieval study; the documents here explain *why* each part is built the way it
is.

| Document | Topic |
|----------|-------|
| [setup.md](setup.md) | Local setup: infrastructure, environment, corpus, and verification |
| [pipeline-overview.md](pipeline-overview.md) | End-to-end data flow: embedding, vector retrieval, generation, and observability |
| [evaluation-harness.md](evaluation-harness.md) | How quality is measured — the hand-authored eval sets and the metrics that matter |
| [input-guardrails.md](input-guardrails.md) | The three-layer input defense: PII, injection, and policy |
| [answer-validation.md](answer-validation.md) | The output validator: corpus-scope guard, citation-coverage and grounding-judge gates, bounded retry, and per-span salvage |
| [api-reference.md](api-reference.md) | HTTP surface: `POST /ask` (with optional diagnostics), `GET /meta`, `GET /ready`, and the error contract |
| [results.md](results.md) | Measured results — retrieval, guardrails, and latency |

All file and line references point at the current source tree. Measured numbers
live in [`reports/`](../reports/); this folder explains method and rationale,
not point-in-time results.
