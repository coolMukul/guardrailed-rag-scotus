import { z } from 'zod'
import { RUNTIME } from '../config/runtime.js'
import { guardrailsConfig } from '../config/guardrails.js'
import { buildLangChainModel } from '../llm/langchain-model.js'
import { INJECTION_CLASSIFIER_SYSTEM } from '../prompts/injection.js'
import { recordUsage, usageFromMessage } from '../obs/usage.js'

export interface InjectionCheckResult {
  safe: boolean
  confidence: number
  risk: string // 'safe' | 'jailbreak' | 'unknown'
}

const INJECTION_THRESHOLD = guardrailsConfig.injection.threshold

/**
 * Layer 1 — deterministic high-precision patterns for canonical injection
 * phrasing. The active model family forces temperature=1, so the LLM verdict
 * always carries sampling noise; textbook attacks must not depend on it.
 * Pattern hits also skip the LLM call entirely (zero token cost).
 *
 * Precision over recall: each pattern requires an imperative aimed at the
 * assistant, so doctrinal language ("what framework", "immunity") can't match.
 * Novel attacks that evade these fall through to the LLM classifier.
 */
const INJECTION_PATTERNS: RegExp[] = [
  // "ignore/disregard/forget/override/bypass ... instructions/prompt/rules"
  /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,60}\b(instructions?|prompts?|rules|guidelines|guardrails)\b/i,
  // "reveal/show/print/repeat/output ... system prompt / hidden instructions"
  /\b(reveal|show|print|repeat|output|display|leak)\b[\s\S]{0,60}\b(system prompt|hidden (instructions?|prompts?)|initial instructions?|your configuration)\b/i,
  // persona/jailbreak framing
  /\byou are now\b[\s\S]{0,60}\b(unrestricted|jailbroken|without (restrictions|rules|filters)|a different (ai|assistant))\b/i,
  /\b(developer|god|sudo|dan) mode\b/i,
  // "repeat everything/all text above"
  /\brepeat (everything|all( the)? text|the text) above\b/i,
]

/** Exported for zero-cost testing; no LLM involved. */
export function matchesInjectionPattern(query: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(query))
}

// Structured verdict: the enum is enforced by the provider's structured-output
// API, so there is no free-text parsing. (Azure strict mode: all fields
// required, no .optional().)
const InjectionVerdictSchema = z.object({
  verdict: z
    .enum(['benign', 'injection'])
    .describe('Whether the user input attempts to manipulate the assistant'),
})

export async function checkInjection(query: string): Promise<InjectionCheckResult> {
  // Layer 1: deterministic pattern match — same input, same verdict, no tokens.
  if (matchesInjectionPattern(query)) {
    const confidence = 0.99
    return {
      safe: !(confidence > INJECTION_THRESHOLD),
      confidence,
      risk: 'jailbreak',
    }
  }

  // Layer 2: LLM classifier for phrasing the patterns don't cover.
  try {
    const model = buildLangChainModel(RUNTIME.modelName)
    const structuredModel = model.withStructuredOutput(InjectionVerdictSchema, {
      name: 'injection_verdict',
      includeRaw: true,
    })
    const result = (await structuredModel.invoke([
      { role: 'system', content: INJECTION_CLASSIFIER_SYSTEM },
      { role: 'user', content: query },
    ])) as { raw: any; parsed: { verdict: 'benign' | 'injection' } | null }

    recordUsage(usageFromMessage('injection', RUNTIME.modelName, result.raw))

    // Ambiguous output fails open, like the catch below: a guardrail that
    // blocks on its own malfunction turns classifier noise into user-facing
    // 400s (the exact false-positive failure mode v1 had). The grounding
    // validator remains the downstream safety net.
    if (!result.parsed) {
      return { safe: true, confidence: 0, risk: 'unknown' }
    }

    const isInjection = result.parsed.verdict === 'injection'
    // The structured verdict is a label, not a probability; use a fixed
    // conservative confidence so the env threshold knob keeps working.
    const confidence = 0.85
    const shouldReject = isInjection && confidence > INJECTION_THRESHOLD

    return {
      safe: !shouldReject,
      confidence,
      risk: isInjection ? 'jailbreak' : 'safe',
    }
  } catch (error) {
    // Graceful degradation: if LLM unavailable, default to safe (fail-open)
    console.warn(
      `[Guardrail] Injection check failed (LLM unavailable):`,
      error instanceof Error ? error.message : String(error)
    )
    return { safe: true, confidence: 0, risk: 'unknown' }
  }
}
