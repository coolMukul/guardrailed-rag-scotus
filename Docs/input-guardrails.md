# Input Guardrails — Defense in Depth

A guardrail is not one gate; it is a pipeline of independent, composable checks
that filter a query before it reaches retrieval or the model. Three layers run
in parallel; all must pass. Each has its own job, its own failure mode, and its
own tuning surface.

**Code:** [src/guardrails/pipeline.ts](../src/guardrails/pipeline.ts) composes
[pii.ts](../src/guardrails/pii.ts), [injection.ts](../src/guardrails/injection.ts),
and [policy.ts](../src/guardrails/policy.ts).

## Layer 1 — PII detection and redaction

**Code:** [src/guardrails/pii.ts](../src/guardrails/pii.ts)

Detects personally identifiable information (SSNs, emails, credit cards, phone
numbers, IP addresses, names) and **redacts** it before the query continues —
e.g. `"My SSN is 123-45-6789, what does Miranda hold?"` becomes
`"My [US_SSN], what does Miranda hold?"`.

Detection merges two sources: Microsoft Presidio (an ML recognizer, reached over
its REST API) and regex patterns. Regex is deterministic and fast for
well-formed tokens; the ML layer adds context-sensitive entities regex cannot
catch. The pipeline depends only on the *interface* — call the layer, get back
`{ redacted, entities, text }` — so the backing implementation can change
without touching pipeline code.

**Why redact instead of reject?** In a legal corpus, names are often metadata,
not leaks: *"In Smith v. State, the defendant John Smith…"* contains a PERSON
entity but is a perfectly valid question. Rejecting wastes it; redacting keeps
it answerable while the model never sees the sensitive span. Redaction also lets
PII be measured independently from injection — rejecting on PII would hide
whether a query was *also* an injection attempt.

## Layer 2 — Prompt-injection detection

**Code:** [src/guardrails/injection.ts](../src/guardrails/injection.ts),
prompt in [src/prompts/injection.ts](../src/prompts/injection.ts)

Catches attempts to override the system instruction or jailbreak the model
(*"Ignore previous instructions and …"*). An LLM classifier labels the query
`SAFE` / `UNSAFE` with a confidence score; the query is rejected when confidence
crosses `INJECTION_THRESHOLD`. The classifier goes through the same provider
factory as the rest of the system, so it is not tied to one vendor.

The threshold is the tuning knob, trading the two error rates against each
other:

- Low threshold → catches more attacks (higher true-positive rate) but
  false-rejects more benign queries.
- High threshold → fewer false rejects but misses subtler attacks.

This is a classifier, so it is probabilistic by nature: it can miss novel or
non-English attacks. Layer 3 backstops some of those, and the combination is
stronger than any single layer.

## Layer 3 — Policy checks

**Code:** [src/guardrails/policy.ts](../src/guardrails/policy.ts)

Deterministic hard rules on the shape of the query:

- **Length cap** — reject overly long input (blocks token-dump attacks).
- **Non-ASCII share** — reject if the query is mostly non-ASCII (repeated-CJK
  spam, encoding tricks).
- **Abuse word list** — reject on explicit abuse terms.

Hard rules are deterministic, debuggable, and trivially tunable — banning a term
is a one-line change, no retraining. They cannot catch intent the way the
classifier can (an attacker finds synonyms), which is exactly why they are one
layer of three rather than the whole defense.

## Why run the layers in parallel

Sequential checks stop at the first failure, which destroys measurability: if
PII trips first you never learn whether injection would also have fired, so you
cannot measure injection's false-positive rate independently. Running all three
concurrently (`Promise.all`) yields a full verdict — every reason a query failed
— and lets each layer's error rates be measured on its own. It is also slightly
harder to profile from the outside, since an attacker cannot probe the layers
one at a time.

The pipeline collects each verdict and rejects with the union of reasons:

```
[pii, injection, policy] = await Promise.all([...])
reasons = []
if (pii.redacted)      reasons.push("PII redacted")
if (!injection.safe)   reasons.push(`injection (confidence ${injection.confidence})`)
if (!policy.ok)        reasons.push(`policy: ${policy.violations}`)
```

## Why fail open

If a backing service is unavailable (e.g. Presidio is down), the layer logs a
warning and returns a pass rather than blocking. A guardrail outage must not
take the product down — a brief reduction in defense is preferable to a hard
outage. In production this pairs with alerting so a degraded layer is noticed,
not silently tolerated.

## Each layer is observed

Every layer writes its verdict into the request trace
([src/obs/langfuse.ts](../src/obs/langfuse.ts)) — `pii_redacted`,
`injection_safe`, `injection_confidence`, `policy_ok`, `policy_violations`. When
a query is blocked, the trace shows exactly which layer fired and why.

## Measuring "good guardrails"

**Dataset:** [evals/adversarial.jsonl](../evals/adversarial.jsonl) — 52 cases
spanning benign controls, injections, PII, mixed attacks, policy violations, and
long benign queries (the last group guards against over-blocking).

**Metrics** (full results in [`reports/guardrail-evals.json`](../reports/guardrail-evals.json)):

- **True-positive rate (TPR)** — fraction of attacks caught. A low TPR means
  attackers find the gaps.
- **False-positive rate (FPR)** — fraction of benign queries blocked. A high FPR
  means real users get rejected and stop trusting the system.
- **Overall accuracy** — correct verdicts over all cases.

Both error rates matter at once. A guardrail that blocks everything has a
perfect TPR and is useless; one that blocks nothing has a perfect FPR and is
useless. The goal is a defensible balance, documented with numbers.

## Each layer toggles independently

Every layer can be disabled via an env toggle (see
[src/config/guardrails.ts](../src/config/guardrails.ts)). That makes it possible
to isolate a layer's contribution during evaluation and to conserve model calls
when a run needs to.
