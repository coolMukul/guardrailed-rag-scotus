# Results

A consolidated scoreboard of what has been measured. This is the *numbers*
companion to [evaluation-harness.md](evaluation-harness.md), which explains the
*method*. Each section links to the raw report it summarizes; nothing here is
re-derived.

> **Status note.** Retrieval, guardrails, and pipeline latency have current,
> committed numbers. End-to-end **answer-quality** metrics (citation coverage,
> grounding pass rate, abstention) do **not** yet have a clean post-validator
> report committed — see [Pending](#pending) below. Numbers are not invented to
> fill that gap.

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
- **Reranking added no quality** on this corpus (MRR 0.965 → 0.954) while adding
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
| PII | 12 | 7 | 58.3% detection |
| Mixed (PII + attack) | 5 | 5 | 100% |
| Policy violation | 1 | 1 | 100% |
| **Overall** | **52** | **47** | **90.4% accuracy** |

- **Injection detection is the strong layer** — every attack caught, zero benign
  queries blocked.
- **PII detection is the weak spot** (58.3% on the PII subset). Because the PII
  layer *redacts* rather than rejects, a missed entity does not block a valid
  query, but the recognizer coverage is the clearest target for improvement.

## Pipeline latency

Source: [reports/study.md](../reports/study.md) (LLM-side, from smoke samples).
Full pipeline = generation + structured-output validation + grounding judge +
up to one retry (~4 model calls/question).

| Configuration | Latency/question | Tokens/question |
|---------------|-----------------:|----------------:|
| 800 / k=8, dense, fast hosted model | ~5.4 s | ~8K |
| 800 / k=8, + rerank + cache-friendly prompts | ~8–24 s* | ~21K |

\* The upper end reflects CPU-contention-inflated rerank latency; ~8–10 s on an
idle CPU.

- **The validator stack dominates the pipeline, not retrieval.** Retrieval is
  ~15 ms of a ~5 s pipeline; the rest is the ~4 model calls per question.
- **Prompt-cache-friendly ordering is implemented** but provider-side caching
  never triggered at eval-scale request rates (0 cached input tokens observed).
  The ordering is kept as correct hygiene; no benefit could be demonstrated at
  this scale.

## Pending

These have a defined method ([evaluation-harness.md](evaluation-harness.md)) but
no current committed report; producing them requires an additional eval run
(`npm run eval`):

- **Citation coverage rate** — share of answers whose every span cites a
  retrieved chunk.
- **Grounding pass rate** — share where the judge confirms the cited chunk
  supports the claim.
- **Validator rejection / retry rate** — share of first attempts that fail and
  regenerate.
- **Abstention accuracy** on out-of-corpus questions, end to end.

The only committed generation report ([reports/validator-eval.json](../reports/validator-eval.json))
predates the validator gates and is **not** representative of current behavior.
