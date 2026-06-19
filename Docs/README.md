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
| [answer-validation.md](answer-validation.md) | The two-gate output validator: citation coverage and grounding-judge with bounded retry |
| [results.md](results.md) | Measured results so far — retrieval, guardrails, and latency (with the answer-quality gap called out) |

All file and line references point at the current source tree. Measured numbers
live in [`reports/`](../reports/); this folder explains method and rationale,
not point-in-time results.
