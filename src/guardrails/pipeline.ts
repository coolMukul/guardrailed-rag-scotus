import { guardrailsConfig } from '../config/guardrails.js'
import { span } from '../obs/langfuse.js'
import { checkPII, PIICheckResult } from './pii.js'
import { checkInjection, InjectionCheckResult } from './injection.js'
import { checkPolicy, PolicyCheckResult } from './policy.js'

export interface GuardrailVerdicts {
  pii: PIICheckResult
  injection: InjectionCheckResult
  policy: PolicyCheckResult
}

export interface GuardrailResult {
  passed: boolean
  verdicts: GuardrailVerdicts
  redacted_query: string
  reason?: string // Why it failed (if failed)
}

// Passing verdicts returned for layers that are disabled via config, so the
// pipeline shape stays identical whether a layer ran or was skipped.
const PII_SKIPPED: PIICheckResult = { redacted: false, text: '', entities: [] }
const INJECTION_SKIPPED: InjectionCheckResult = { safe: true, confidence: 1, risk: 'skipped' }
const POLICY_SKIPPED: PolicyCheckResult = { ok: true, violations: [] }

/**
 * Run all enabled guardrail layers against the query.
 *
 * @param trace Optional observability trace; when provided, each layer gets
 *              its own span with the verdict in metadata. span() no-ops on
 *              null, so callers without tracing pass nothing.
 */
export async function guardrailInput(query: string, trace?: unknown): Promise<GuardrailResult> {
  const t = trace ?? null

  // Run all enabled checks in parallel
  const [pii, injection, policy] = await Promise.all([
    guardrailsConfig.pii.enabled
      ? span(t, 'guardrail_pii', () => checkPII(query))
      : Promise.resolve({ ...PII_SKIPPED, text: query }),
    guardrailsConfig.injection.enabled
      ? span(t, 'guardrail_injection', () => checkInjection(query))
      : Promise.resolve(INJECTION_SKIPPED),
    guardrailsConfig.policy.enabled
      ? span(t, 'guardrail_policy', async () => checkPolicy(query))
      : Promise.resolve(POLICY_SKIPPED),
  ])

  const verdicts: GuardrailVerdicts = { pii, injection, policy }

  // Verdict logic: all three must pass
  const passed = !pii.redacted && injection.safe && policy.ok

  if (!passed) {
    let reason = ''
    if (pii.redacted) reason += 'PII detected; '
    if (!injection.safe) reason += `Injection risk detected (confidence: ${injection.confidence.toFixed(2)}); `
    if (!policy.ok) reason += `Policy violation: ${policy.violations.join(', ')}; `
    reason = reason.trim().replace(/;$/, '')

    return {
      passed: false,
      verdicts,
      redacted_query: query,
      reason,
    }
  }

  // If passed, return the (potentially) redacted query
  return {
    passed: true,
    verdicts,
    redacted_query: pii.text,
  }
}
