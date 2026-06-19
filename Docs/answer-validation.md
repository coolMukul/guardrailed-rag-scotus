# Answer Validation — Grounded Citations

Generation alone is not trustworthy: a model can produce fluent, plausible text
that the retrieved opinions do not support. The validator turns "sounds right"
into "is supported," using two gates and a bounded retry. Cheap structural
checks run first; the expensive semantic check runs only if they pass; if the
answer still cannot be grounded, the system abstains rather than ship an
unsupported answer.

## Structured output is the precondition

**Code:** [src/generate/schema.ts](../src/generate/schema.ts),
prompt in [src/prompts/generation.ts](../src/prompts/generation.ts)

Generation returns schema-validated JSON, not free text:

```jsonc
{
  "answer_spans": [
    { "text": "Miranda held that…", "citation_ids": [0, 1] },
    { "text": "The Court extended this…", "citation_ids": [2] }
  ],
  "citations": [
    { "chunk_id": 0, "case_name": "Miranda v. Arizona", "citation": "384 U.S. 436 (1966)", "text": "…" }
  ]
}
```

The prompt lists each retrieved chunk with an explicit index (`[0]`, `[1]`, …)
and instructs the model to cite only those indices and never its training
knowledge. Showing the index scheme up front keeps `citation_ids` aligned and
prevents off-by-one drift. Because the output is schema-validated at the
boundary, malformed output is rejected immediately — there is no parse-and-hope
path, and the typed answer flows cleanly into both gates.

## Gate 1 — Citation coverage (deterministic)

**Code:** [src/validator/citation-coverage.ts](../src/validator/citation-coverage.ts)

A fast set-membership check over the spans:

```
retrievedIds = set(retrieved chunk ids)
for span in answer_spans:
    if span has no citation_ids:        fail  ("uncited span")
    for id in span.citation_ids:
        if id not in retrievedIds:      fail  ("cited a chunk that was never retrieved")
```

It catches the **structural** failures — an uncited assertion, or a citation to
a chunk that was never retrieved (which is impossible to ground and a tell-tale
of fabrication). It says nothing about whether a *retrieved* chunk actually
supports the claim. It is O(n) and nearly free, so it runs first and short-
circuits the expensive gate.

## Gate 2 — Grounding judge (semantic, LLM-as-judge)

**Code:** [src/validator/grounding-judge.ts](../src/validator/grounding-judge.ts),
prompt in [src/prompts/judge.ts](../src/prompts/judge.ts)

For each span, an LLM is asked whether the cited chunk **entails** the claim —
`yes` / `no` / `uncertain`, with a reason. `no` or `uncertain` fails the span
and the reason is recorded. This catches the failures coverage cannot: the model
cited the right chunk but overstated it, or the chunk is on-topic but does not
actually support the specific assertion.

**Why an LLM judge** rather than a dedicated NLI model? Semantic entailment is
hard to compute locally; one extra model call is acceptable and avoids
loading and maintaining a second local model. The honest limitation is that the
judge and the generator may be the same model family, so their judgments
correlate — acceptable as a first gate, and mitigated by giving the judge a
distinct, stricter prompt. Where reliability matters more, the judge can be
escalated to a stronger model or a multi-judge quorum without changing the
surrounding flow.

The judge also fails open: if the judge call itself errors (network, outage),
the span is treated as passing. A transient infrastructure failure should not
drop a request, and the fallback introduces no new fabrication.

## Bounded retry, then abstain

**Code:** [src/validator/retry.ts](../src/validator/retry.ts)

```
attempt 1:
  coverage → fail ⇒ insufficient_evidence
  grounding → pass ⇒ valid
            → fail, retry left ⇒ regenerate with corrective feedback
            → fail, no retry  ⇒ insufficient_evidence
attempt 2 (with feedback):
  coverage → fail ⇒ insufficient_evidence
  grounding → pass ⇒ valid
            → fail ⇒ insufficient_evidence
```

On a grounding failure the model is regenerated **once**, with feedback naming
exactly which spans failed and why:

```
Your previous answer had issues:
- Span 2 ("X held Y") — the cited chunk does not support this claim. Re-read it.
Regenerate, citing only what the excerpts explicitly state.
```

Retry is bounded to one round. A single corrective pass usually works because
the feedback is specific; looping further wastes model calls on questions
that are genuinely unanswerable from the corpus. When the second attempt still
fails, the system returns `insufficient_evidence`.

**Abstention is a feature, not a failure.** "I cannot answer this from the
provided opinions" is the correct response to an out-of-corpus question and is
far better than a confident fabrication.

## Worked example — a hallucination caught

The model claims *"Miranda extended Fourth Amendment protections to all detained
persons,"* citing chunk 0.

1. **Coverage** — chunk 0 was retrieved and the span is cited → pass.
2. **Grounding** — the judge reads chunk 0 ("…in custodial interrogation…") and
   the claim ("all detained persons"), finds the claim broader than the source →
   fail.
3. **Regenerate** — feedback: *"Span 0 claims 'all detained persons' but the
   chunk only covers custodial interrogation; cite only what is stated."*
4. **Re-validate** — the new span ("…must give warnings before custodial
   interrogation") passes both gates → `valid`.

## Design decisions

**Two gates, not one.** Coverage is fast and catches structural errors before the
judge is invoked; grounding is slow and catches semantic errors.
They catch different failures, so both earn their place.

**Cheap-before-expensive ordering.** Most answers clear coverage instantly; the
judge only runs on what survives. Latency tracks real need.

**Everything is observed.** Per-span verdicts, the failed reasons, and retry
count all land in the request trace
([src/obs/langfuse.ts](../src/obs/langfuse.ts)), so coverage pass rate,
grounding pass rate, and rejection rate are measurable on the eval sets (see
[evaluation-harness.md](evaluation-harness.md)).
