import { guardrailsConfig } from '../config/guardrails.js'

export interface PolicyConfig {
  maxLength: number
  maxNonAsciiPercent: number
  abuseWords: string[]
}

export interface PolicyCheckResult {
  ok: boolean
  violations: string[]
}

const DEFAULT_CONFIG: PolicyConfig = {
  maxLength: guardrailsConfig.policy.maxLength,
  maxNonAsciiPercent: guardrailsConfig.policy.maxNonAsciiPercent,
  abuseWords: [
    'bomb',
    'exploit',
    'hack',
    'crack',
    'ddos',
    'malware',
    'ransomware',
    'worm',
    'virus',
    'trojan',
    'phishing',
    'scam',
  ],
}

export function checkPolicy(query: string, config: PolicyConfig = DEFAULT_CONFIG): PolicyCheckResult {
  const violations: string[] = []

  // Check 1: Length cap
  if (query.length > config.maxLength) {
    violations.push(`query too long (${query.length} > ${config.maxLength})`)
  }

  // Check 2: Language filter (reject mostly non-ASCII, likely spam)
  const nonAsciiChars = query.split('').filter((c) => c.charCodeAt(0) > 127).length
  const nonAsciiPercent = (nonAsciiChars / query.length) * 100
  if (nonAsciiPercent > config.maxNonAsciiPercent) {
    violations.push(`excessive non-ASCII characters (${nonAsciiPercent.toFixed(1)}%)`)
  }

  // Check 3: Abuse word list
  const queryLower = query.toLowerCase()
  const foundAbuse = config.abuseWords.filter((word) => queryLower.includes(word))
  if (foundAbuse.length > 0) {
    violations.push(`potential abuse terms detected: ${foundAbuse.join(', ')}`)
  }

  return {
    ok: violations.length === 0,
    violations,
  }
}
