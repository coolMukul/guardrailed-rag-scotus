# Cost/Latency Study: Retrieval Configuration Sweep

**Date:** 2026-06-11
**Corpus:** 495 US Supreme Court opinions (2023–2025 terms)
**Eval set:** `evals/platinum.jsonl` — 50 hand-authored questions (40 in-corpus, 10 out-of-corpus abstention probes)
**Raw data:** `reports/retrieval-study.json`, `reports/smoke-test.json`

---

## Summary

- Swept the retrieval-side dimensions locally at zero LLM cost: chunk size {512, 800, 1200} × dense search, plus a cross-encoder rerank cell (pool 16 → top 8) on the 800-token collection.
- **Dense retrieval is at ceiling on this corpus**: hit@8 = 100% for every chunk size. The differentiator is ranking quality (MRR) and score separation, not recall.
- **Reranking adds no quality here and is not free**: MRR went *down* slightly (0.965 → 0.954) and p50 latency rose by ~1.8s/query on an idle CPU (~12–14s/query when the CPU was busy).
- **Recommended configuration: chunk = 800 tokens, top-k = 8, reranker off, dense-only.**

## Methodology

### Why a zero-LLM-cost sweep

A full 36-cell factorial (chunk × top-k × rerank × cache, 50 questions each ≈ 1,800 LLM calls, each with a generation + judge + possible retry ≈ 4 calls/question) was measured on a 3-question smoke sample first: ~24s and ~$0.0024 per question end-to-end. Extrapolated, the full sweep would cost real money and ~12 hours of wall-clock for numbers that the smoke samples already characterize. The retrieval-side dimensions — the ones that actually vary quality on this corpus — are measurable locally for free, so the sweep was split:

- **Retrieval dimensions** (chunk size, ranking, rerank): measured exhaustively and locally via `scripts/run-retrieval-study.ts` against three fully-ingested Qdrant collections (34,343 / 27,374 / 15,382 points for 512/800/1200-token chunks).
- **LLM dimensions** (generation cost, latency, prompt caching): documented from the smoke samples (`reports/smoke-test.json`) rather than re-measured per cell, since chunk size and top-k shift the prompt length predictably and nothing else.

### Why `platinum.jsonl` and not `golden.jsonl`

The original golden set asks about landmark cases (Miranda, Roe, Brown…) that predate the corpus (2023–2025 opinions), so its retrieval metrics carry no signal — every question is out-of-corpus. The platinum set targets cases actually in the corpus (Loper Bright, Jarkesy, Trump v. United States, …) and repurposes 10 landmark questions as deliberate out-of-corpus abstention probes.

### Metrics

- **hit@k** — was any chunk from the expected case in the top k (k = 5, 8, 12)?
- **MRR@12** — mean reciprocal rank of the first relevant chunk; rewards putting the right chunk first.
- **Score separation** — mean top-1 similarity for in-corpus vs out-of-corpus questions; measures whether raw scores could gate abstention.
- **Search p50/p95** — Qdrant query latency, measured on an idle CPU (embedder warm).

## Dense retrieval: chunk size sweep

50 questions per cell, top-k up to 12, dense-only (bge-small-en-v1.5, 384-dim, local CPU):

| Chunk size | Points | hit@5 | hit@8 | hit@12 | MRR@12 | Top-1 in-corpus | Top-1 out-of-corpus | Separation | Search p50 | p95 |
|-----------:|-------:|------:|------:|-------:|-------:|----------------:|--------------------:|-----------:|-----------:|----:|
| 512  | 34,343 | 100% | 100% | 100% | 0.926 | 0.763 | 0.730 | 0.033 | 17 ms | 26 ms |
| **800**  | **27,374** | **100%** | **100%** | **100%** | **0.965** | **0.749** | **0.706** | **0.043** | **15 ms** | **18 ms** |
| 1200 | 15,382 | 100% | 100% | 100% | 0.963 | 0.745 | 0.695 | 0.050 | 14 ms | 19 ms |

**Findings:**

1. **Recall is saturated at every chunk size.** Supreme Court opinions are highly distinctive documents (unique party names, dense legal vocabulary), and single-case factual questions name their case. hit@k cannot differentiate configurations here — which is itself the lesson: pick metrics that still have headroom.
2. **800 tokens wins on ranking quality.** MRR 0.965 vs 0.926 for 512. Smaller chunks fragment the holding across more pieces, so the *first* relevant chunk lands lower in the list. 1200 matches 800's MRR (0.963) but with no upside and a larger prompt per chunk downstream.
3. **Search latency is a non-factor** (14–17 ms p50 across a 2.2× range in collection size). The expensive parts of the pipeline are elsewhere.
4. **Score separation grows with chunk size** (0.033 → 0.043 → 0.050) but is far too small to gate abstention on: an out-of-corpus question about Miranda still scores 0.70+ against a 2024 opinion that merely *cites* Miranda. This validates the architecture decision to handle abstention in the validator layer (citation coverage + grounding judge), not with a similarity threshold.

## Reranking: cross-encoder cell

Cross-encoder reranker (bge-reranker-base, local CPU), pool = 16 dense candidates → top 8, on the 800-token collection, 40 in-corpus questions:

| Metric | Dense only | + Reranker |
|--------|-----------:|-----------:|
| hit@8 | 100% | 100% |
| MRR | 0.965 | 0.954 |
| Added latency p50 | — | +1,781 ms |
| Added latency p95 | — | +2,964 ms |
| Avg rank improvement | — | −0.07 (slightly worse) |

**Findings:**

1. **No headroom, no benefit.** Dense retrieval already places a relevant chunk at rank ~1; the reranker can only reshuffle a list that is already correct. It occasionally promotes a rhetorically-similar but less-cited passage, which is why MRR ticks *down*.
2. **The latency cost was initially mis-measured by 7×.** Under CPU contention (three ingest workers running), the reranker measured 12–14 s/query. On an idle CPU it is ~1.8 s p50. Lesson: never benchmark a CPU-bound component while other CPU-bound work is running — and record machine state alongside every benchmark.
3. **Keep the component, ship it off.** The reranker stays in the codebase behind a runtime flag — on a corpus with genuinely ambiguous retrieval (near-duplicate documents, paraphrase-heavy questions) the cross-encoder would earn its latency. On this corpus it cannot.

## LLM-side costs (from smoke samples)

Measured on small samples rather than per-cell (see Methodology). Full pipeline = generation + structured-output validation + grounding judge + up to 1 retry (~4 LLM calls/question).

| Configuration | Latency/question | Tokens/question | Cost/question |
|---------------|----------------:|----------------:|--------------:|
| chunk 800, k=8, no rerank, no cache (fast hosted model) | ~5.4 s | ~8K | ~$0.0011 |
| chunk 800, k=8, rerank + cache-friendly prompts | ~20–24 s* | ~21K | ~$0.0024 |

\* includes the contention-inflated rerank latency; on an idle CPU this drops to ~8–10 s.

**Prompt caching:** cache-friendly prompt ordering (static system + few-shot prefix, volatile chunks last) was implemented and enabled, but the provider reported **0 cached input tokens** across all samples — implicit caching never triggered at this request rate. The restructuring is kept (it costs nothing and is correct hygiene for any provider with prefix caching), but no cost/latency benefit could be demonstrated at this scale. Caching pays off on sustained traffic with shared prefixes, not on one-off evals.

The cost driver is the validator stack (×4 calls), not retrieval configuration: tokens scale linearly with k × chunk size, but even the heaviest cell is ~$0.0024/question. At this corpus size, **quality engineering is free; the only real spend is the judge.**

## Recommendation

**chunk = 800 tokens · top-k = 8 · reranker off · dense-only retrieval**

- Best ranking quality measured (MRR 0.965, hit@8 100%)
- Retrieval contributes ~15 ms to a ~5 s pipeline — effectively free
- Reranking adds 1.8–14 s (machine-state dependent) for zero measured quality gain on this corpus; keep it available behind its flag for corpora where dense retrieval is not already at ceiling
- Abstention must stay in the validator layer; similarity scores cannot gate it (0.04 separation)

## Limitations

- Recall metrics are at ceiling, so this study differentiates configurations by MRR only; a harder eval set (multi-case synthesis questions, paraphrases that avoid party names) would re-open the gap and could change the rerank verdict.
- The rerank cell ran on the 800-token collection only; rerank × {512, 1200} interactions are unmeasured (justified by rerank showing no benefit at its strongest baseline).
- LLM-side numbers come from 3–5-question samples, not 50-question runs; they are order-of-magnitude estimates, not tight intervals.
- All latency numbers are single-machine, CPU-only, and sensitive to machine load (see the 7× rerank discrepancy).
