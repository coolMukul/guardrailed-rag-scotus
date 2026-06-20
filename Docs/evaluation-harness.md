# Evaluation Harness

RAG quality depends on retrieval *and* generation *and* validation interacting.
Unit tests cannot verify that. The test suite is therefore a set of
hand-authored evaluation sets plus runners that score the pipeline against them.
This document explains the design — the datasets, the metrics, and why those
metrics were chosen. Point-in-time numbers live in [`reports/`](../reports/).

## The datasets

**Code:** [evals/](../evals/)

| File | Size | Purpose |
|------|------|---------|
| `golden.jsonl` | 50 questions | Core quality set across four categories |
| `adversarial.jsonl` | 52 cases | Guardrail stress set (see [input-guardrails.md](input-guardrails.md)) |
| `platinum.jsonl` | 50 questions | Curated set used for the retrieval configuration study |

Each line is one JSON record (`id`, `question`, `expected_citations`,
`category`, `notes`). JSONL is used because it streams line-by-line, appends
without reformatting, and is the standard shape for eval tooling.

### Why these four categories

The golden set is split deliberately — each category exercises a different
failure mode:

| Category | Count | Tests |
|----------|------:|-------|
| Factual single-case | 15 | Retrieval — can it find the right case by name? |
| Cross-case comparative | 15 | Synthesis — can it reason across multiple opinions? |
| Adversarial-but-benign | 10 | Safety — does it correct a false premise instead of agreeing? |
| Out-of-corpus | 10 | Abstention — does it refuse rather than invent a case? |

Testing only factual questions would be misleading: retrieval can succeed (the
right chunk was found) while generation still fails (it misreads the chunk or
fills gaps from training knowledge). Comparative questions catch that.
Adversarial questions catch blind trust in the input. Out-of-corpus questions
catch the single most damaging RAG failure — confidently fabricating an answer.

### Why hand-curated

Automated similarity-to-ground-truth scoring is convenient but a poor proxy for
quality: it punishes legitimate paraphrase and rewards plausible-but-wrong text.
Hand-curation lets the eval define what "correct" means for this domain, reason
about edge cases ("is it acceptable to omit the year in a citation?"), and stay
honest about nuance. Automation is for measuring at scale once the measure is
defined — not for defining it.

## The runners

**Code:** [scripts/run-eval.ts](../scripts/run-eval.ts),
[scripts/eval-guardrails.ts](../scripts/eval-guardrails.ts),
[scripts/run-retrieval-study.ts](../scripts/run-retrieval-study.ts)

A runner streams a dataset, sends each question through the live pipeline, and
records per-question latency, token counts, and the quality signals below.
Results are aggregated and written under [`reports/`](../reports/).

## The metrics

**Retrieval@k** — was a relevant chunk in the top-k? Isolates retrieval quality
from generation. Cheap to compute by comparing chunk metadata against the
question's expected citations.

**Citation recall** — did the answer cite the expected case(s)? A generation
signal. Cheap, but approximate: it confirms the case is mentioned, not that the
claim is correct or grounded — that is the validator's job (see
[answer-validation.md](answer-validation.md)).

**Abstention accuracy** — for out-of-corpus questions, did the system refuse
rather than hallucinate?

**Latency and usage** — per-question p50/p95 latency and token counts, sourced
from the observability layer.

### Why measure retrieval@k *and* citation recall

They fail independently, and seeing both lets you localize a problem:

- High retrieval@k, low citation recall → retrieval is fine; generation is weak.
- Low retrieval@k, high citation recall → retrieval missed; generation filled
  the gap from training knowledge (a hallucination risk).
- Both low → broken. Both high → working.

One number alone cannot make that distinction.

## How a single question is scored

1. **Load** the record (question, expected citations, category).
2. **Retrieve** — embed the question, search Qdrant, take the top-k chunks.
3. **Generate** — structured answer with citation ids.
4. **Score** — compute retrieval@k and citation recall against the expected
   citations; capture latency and tokens from the trace.
5. **Store** the per-question result; aggregate across the set (averages,
   percentiles, totals).

## Gotchas

- **Citation recall is a substring signal.** It checks that the expected case
  appears in the answer, not that the surrounding claim is accurate. True
  grounding is verified separately by the LLM-as-judge validator.
- **Retrieval@k leans on metadata.** If a chunk's `case_name` / `citation` are
  missing, retrieval@k under-counts a retrieval that actually succeeded. Good
  ingest metadata is a prerequisite for trustworthy evals.
- **Latency is dominated by the model call.** Embedding and Qdrant search are a
  few tens of milliseconds; the generation and judge calls are the rest.
  Optimization effort belongs where the time actually goes.
- **Out-of-corpus probes are optimistic.** A "non-existent" case can still be
  mentioned in passing inside a real opinion. Spot-check the abstention cases.
