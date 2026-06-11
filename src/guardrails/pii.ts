export interface PIICheckResult {
  redacted: boolean
  text: string
  entities: {
    type: string
    value: string
    start: number
    end: number
  }[]
}

import { guardrailsConfig } from '../config/guardrails.js'

const PRESIDIO_URL = guardrailsConfig.pii.presidioUrl

interface PresidioEntity {
  entity_type: string
  start: number
  end: number
  score: number
}

// Regex patterns for common PII (fast, deterministic)
const PII_PATTERNS = [
  {
    type: 'US_SSN',
    pattern: /\b(\d{3}-\d{2}-\d{4}|\d{9})\b/g,
    description: 'Social Security Number (XXX-XX-XXXX or 9 digits)',
  },
  {
    type: 'EMAIL_ADDRESS',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    description: 'Email address',
  },
  {
    type: 'CREDIT_CARD',
    pattern: /\b(\d{4}[\s-]?){3}\d{4}\b/g,
    description: 'Credit card number',
  },
  {
    type: 'PHONE_NUMBER',
    pattern: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
    description: 'Phone number',
  },
  {
    type: 'IP_ADDRESS',
    pattern: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
    description: 'IP address',
  },
]

async function detectPIIFromPresidio(text: string): Promise<Array<{ type: string; value: string; start: number; end: number }>> {
  try {
    const response = await fetch(`${PRESIDIO_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: 'en' }),
    })

    if (!response.ok) {
      console.warn(`[Guardrail] Presidio API error: ${response.status}`)
      return []
    }

    // Presidio returns array directly, not {results: [...]}
    const data = (await response.json()) as PresidioEntity[]

    // Filter high-confidence results only (0.95+) to avoid false positives on case names
    // Presidio's PERSON detector flags legal case names; high threshold reduces this
    return data
      .filter((e) => e.score >= 0.95)
      .map((e) => ({
        type: e.entity_type,
        value: text.substring(e.start, e.end),
        start: e.start,
        end: e.end,
      }))
  } catch (error) {
    console.warn(`[Guardrail] Presidio check failed:`, error instanceof Error ? error.message : String(error))
    return []
  }
}

function detectPIIFromRegex(text: string): Array<{ type: string; value: string; start: number; end: number }> {
  const entities: Array<{ type: string; value: string; start: number; end: number }> = []

  for (const piiType of PII_PATTERNS) {
    let match
    piiType.pattern.lastIndex = 0

    while ((match = piiType.pattern.exec(text)) !== null) {
      entities.push({
        type: piiType.type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return entities
}

function mergeAndDedupeEntities(
  presidioEntities: Array<{ type: string; value: string; start: number; end: number }>,
  regexEntities: Array<{ type: string; value: string; start: number; end: number }>
): Array<{ type: string; value: string; start: number; end: number }> {
  // Combine both sources
  const all = [...presidioEntities, ...regexEntities]

  // Dedupe: keep entities with same span (prefer Presidio if both found)
  const seen = new Set<string>()
  const deduped: Array<{ type: string; value: string; start: number; end: number }> = []

  for (const entity of all) {
    const key = `${entity.start}-${entity.end}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(entity)
    }
  }

  // Sort by position
  return deduped.sort((a, b) => a.start - b.start)
}

export async function checkPII(query: string): Promise<PIICheckResult> {
  try {
    // Run both Presidio (ML-based) and regex (deterministic) in parallel
    const [presidioEntities, regexEntities] = await Promise.all([
      detectPIIFromPresidio(query),
      Promise.resolve(detectPIIFromRegex(query)),
    ])

    // Merge results: use both Presidio (comprehensive) and regex (fast)
    const entities = mergeAndDedupeEntities(presidioEntities, regexEntities)

    if (entities.length === 0) {
      return { redacted: false, text: query, entities: [] }
    }

    // Redact detected entities (process in reverse to maintain indices)
    let redactedText = query
    for (const entity of [...entities].reverse()) {
      redactedText = redactedText.substring(0, entity.start) + `[${entity.type}]` + redactedText.substring(entity.end)
    }

    return { redacted: true, text: redactedText, entities }
  } catch (error) {
    console.warn(`[Guardrail] PII check failed:`, error instanceof Error ? error.message : String(error))
    return { redacted: false, text: query, entities: [] }
  }
}
