# Results

The repository ships with an evaluation suite. Running it produces the numbers
below: retrieval is measured deterministically (no model calls), and the input
guardrails are measured against a labelled adversarial set. Each table links to
the report it comes from.

## Retrieval configuration

Source: [reports/study.md](../reports/study.md), [reports/retrieval-study.json](../reports/retrieval-study.json)
— 50-question `platinum.jsonl` set, dense retrieval, local CPU.

| Chunk size | hit@8 | MRR@12 | Score separation | Search p50 |
|-----------:|------:|-------:|-----------------:|-----------:|
| 512 | 100% | 0.926 | 0.033 | 17 ms |
| **800** | **100%** | **0.965** | **0.043** | **15 ms** |
| 1200 | 100% | 0.963 | 0.050 | 14 ms |

- **Recall is saturated** (hit@8 = 100% everywhere) — opinions are distinctive
  and factual questions name their case. Configurations are differentiated by
  ranking quality (MRR), where 800-token chunks win.
- **Reranking adds no quality** on this corpus (MRR 0.965 → 0.954) while adding
  ~1.8 s/query; it stays behind a runtime flag.
- **Similarity scores cannot gate abstention** — in/out-of-corpus top-1
  separation is only ~0.04. Abstention is handled in the validator layer instead.

**Production configuration:** 800-token chunks · top-k = 8 · dense-only ·
reranker off.

## Input guardrails

Source: [reports/guardrail-evals.json](../reports/guardrail-evals.json) — 52-case
`adversarial.jsonl` set. See [input-guardrails.md](input-guardrails.md) for the
design.

| Category | Cases | Correct | Rate |
|----------|------:|--------:|-----:|
| Benign control | 16 | 16 | 100% |
| Injection | 18 | 18 | **TPR 100%, FPR 0%** |
| PII | 12 | 6 | 50.0% detection |
| Mixed (PII + attack) | 5 | 5 | 100% |
| Policy violation | 1 | 1 | 100% |
| **Overall** | **52** | **46** | **88.5% accuracy** |

- **Injection detection is the strong layer** — every attack caught, zero benign
  queries blocked.
- **PII detection is the narrower layer** (50% on the PII subset, measured at the
  redaction layer alone). Because that layer *redacts* rather than rejects, a
  missed entity does not block a valid query — and overlapping cases (PII bundled
  with an attack) are still caught by the injection and policy layers.

## Latency

A single question runs ~4 model calls — generation, structured-output
validation, the grounding judge, and at most one retry. On the production
configuration (800-token chunks, k = 8, dense, with a fast hosted model) that is
about **5.4 s and ~8K tokens per question**. Retrieval itself is ~15 ms; the time
is in the model calls, not retrieval.

Answer quality (citation coverage, grounding, abstention accuracy) is enforced by
the validator described in [answer-validation.md](answer-validation.md) and
scored by the companion evaluation harness.
