# Answer Validation — Grounded Citations

Generation alone is not trustworthy: a model can produce fluent, plausible text
that the retrieved opinions do not support. The validator turns "sounds right"
into "is supported," using a deterministic scope guard, two citation gates, and a
bounded retry. A question about a case outside the corpus is refused before
generation; cheap structural checks run first; the expensive semantic check runs
only if they pass; and when only part of an answer is grounded, the supported
part is kept and the rest dropped rather than shipped unsupported. If nothing can
be grounded, the system abstains.

## Structured output is the precondition

**Code:** [src/generate/schema.ts](../src/generate/schema.ts),
prompt in [src/prompts/generation.ts](../src/prompts/generation.ts)

Generation returns schema-validated JSON, not free text:

```jsonc
{
  "abstained": false,
  "answer_spans": [
    { "text": "Miranda held that…", "citation_ids": [0, 1] },
    { "text": "The Court extended this…", "citation_ids": [2] }
  ],
  "citations": [
    { "chunk_id": 0, "case_name": "Miranda v. Arizona", "citation": "384 U.S. 436 (1966)", "text": "…" }
  ]
}
```

`abstained` is the explicit refusal signal. When the model cannot answer from the
excerpts it sets `abstained: true` and the answer is reported as an abstention —
regardless of how the refusal text happens to cite a chunk. This is the single
source of truth for "did it answer?", so a refusal can never be mislabeled as a
valid answer just because it carries a citation.

The prompt lists each retrieved chunk with an explicit index (`[0]`, `[1]`, …)
and instructs the model to cite only those indices and never its training
knowledge. Showing the index scheme up front keeps `citation_ids` aligned and
prevents off-by-one drift. Because the output is schema-validated at the
boundary, malformed output is rejected immediately — there is no parse-and-hope
path, and the typed answer flows cleanly into both gates.

## Gate 0 — Corpus-scope guard (deterministic, before generation)

**Code:** [src/validator/corpus-scope.ts](../src/validator/corpus-scope.ts)

The corpus covers a fixed set of opinions. If a question names a specific case
(`PARTY v. PARTY`) whose own opinion was not retrieved, the holding must not be
answered — even when a *related* in-corpus opinion recites it. Grounding alone
cannot enforce this: a claim reconstructed from another case's chunk genuinely
*is* entailed by that chunk, so the judge passes it. The guard closes that gap
deterministically, and runs **before generation** so an out-of-scope question
costs no model calls.

The check parses each named case from the question and asks whether some
retrieved `case_name` carries that case's party surnames. It is deliberately
biased toward answering, in two ways:

- A case counts as present when a retrieved name carries **both** its party
  surnames, so an answerable in-corpus question is never falsely refused.
- Each named case is judged **independently**, and the guard fires only when
  **every** named case is absent. A comparative names two cases that live in
  different chunks, so each is checked against the retrieved set on its own. As
  long as any named case is present, the request proceeds and retrieval plus
  grounding handle the rest.

When the guard fires it short-circuits to `insufficient_evidence`. Questions with
no `PARTY v. PARTY` reference are left untouched — the generation prompt is the
backstop there.

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

For each span, an LLM is asked whether the cited chunk **entails** the claim, with
a reason. Entailment is judged fairly, not literally: a faithful paraphrase or a
direct inference a careful reader would draw from the chunk passes; a span fails
only when the chunk does not support it or contradicts it. This catches the
failures coverage cannot: the model cited the right chunk but overstated it, or
the chunk is on-topic but does not actually support the specific assertion. The
verdict is **per span**, so a partly-supported answer can keep its supported
spans (below).

**Why an LLM judge** rather than a dedicated NLI model? Semantic entailment is
hard to compute locally; one extra model call is acceptable and avoids
loading and maintaining a second local model. The honest limitation is that the
judge and the generator may be the same model family, so their judgments
correlate — acceptable as a first gate, and mitigated by giving the judge a
distinct prompt and an independent per-span rubric. Where reliability matters
more, the judge can be escalated to a stronger model or a multi-judge quorum
without changing the surrounding flow.

The judge also fails open: if the judge call itself errors (network, outage),
the span is treated as passing. A transient infrastructure failure should not
drop a request, and the fallback introduces no new fabrication.

## Bounded retry, then per-span salvage, then abstain

**Code:** [src/validator/retry.ts](../src/validator/retry.ts)

Two situations short-circuit straight to abstention before any gate runs: the
generator set `abstained` (it declined to answer), or Gate 0 fired. Otherwise:

```
generator abstained ⇒ insufficient_evidence
attempt 1:
  coverage  → fail ⇒ insufficient_evidence
  grounding → all spans pass        ⇒ valid
            → some fail, retry left ⇒ regenerate with corrective feedback
            → some fail, no retry   ⇒ salvage (below)
attempt 2 (with feedback):
  coverage  → fail ⇒ insufficient_evidence
  grounding → all spans pass ⇒ valid
            → some fail       ⇒ salvage (below)

salvage: keep the spans the judge supported, drop the unsupported ones,
         prune citations to what survives
  any span survives ⇒ valid (partial answer)
  no span survives  ⇒ insufficient_evidence
```

On a grounding failure the model is first regenerated **once**, with feedback
naming exactly which spans failed and why:

```
Your previous answer had issues:
- Span 2 ("X held Y") — the cited chunk does not support this claim. Re-read it.
Regenerate, citing only what the excerpts explicitly state.
```

Retry is bounded to one round — a single specific correction usually works, and
looping further wastes model calls. When a span remains unsupported after the
retry, per-span salvage keeps the spans the judge supported and drops only the
unsupported ones, pruning the citations to match; the answer is reported `valid`
as long as at least one span survives. A correct core holding is returned even
when a secondary detail could not be grounded.

When no span survives — nothing in the answer can be grounded — the system
returns `insufficient_evidence`. "I cannot answer this from the provided
opinions" is the correct response to an out-of-corpus question, and far better
than a confident fabrication.

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
