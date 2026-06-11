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

export async function checkInjection(query: string): Promise<InjectionCheckResult> {
  try {
    const model = buildLangChainModel(RUNTIME.modelName)
    const response = await model.invoke([
      {
        role: 'system',
        content: INJECTION_CLASSIFIER_SYSTEM,
      },
      {
        role: 'user',
        content: query,
      },
    ])

    recordUsage(usageFromMessage('injection', RUNTIME.modelName, response))

    const text = typeof response.content === 'string' ? response.content : String(response.content)
    const output = text.trim().toUpperCase()

    // Parse response: "safe" or "unsafe"
    const isSafe = output.includes('SAFE') && !output.includes('UNSAFE')

    // Confidence varies by provider; use a conservative estimate since the
    // classifier reports a label, not a probability
    const confidence = isSafe ? 0.85 : 0.80

    // Decision: reject if unsafe and confidence exceeds threshold
    const shouldReject = !isSafe && confidence > INJECTION_THRESHOLD

    return {
      safe: !shouldReject,
      confidence,
      risk: isSafe ? 'safe' : 'jailbreak',
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
