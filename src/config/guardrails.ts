/**
 * Guardrail configuration: every tunable knob for the input-defence layers
 * (PII, injection, policy) lives here so thresholds and toggles are auditable
 * in one place rather than scattered across the layer implementations.
 *
 * Each layer can be disabled independently via env (useful when measuring a
 * single layer's false-positive rate in isolation).
 */

export const guardrailsConfig = {
  // Injection detection
  injection: {
    threshold: parseFloat(process.env.INJECTION_THRESHOLD || '0.7'),
    enabled: process.env.GUARDRAILS_INJECTION_ENABLED !== 'false',
  },

  // PII detection (Presidio analyzer; docker-compose maps it to port 5001)
  pii: {
    enabled: process.env.GUARDRAILS_PII_ENABLED !== 'false',
    presidioUrl: process.env.PRESIDIO_URL || 'http://localhost:5001',
  },

  // Policy checks
  policy: {
    enabled: process.env.GUARDRAILS_POLICY_ENABLED !== 'false',
    maxLength: parseInt(process.env.POLICY_MAX_LENGTH || '5000', 10),
    // Reject queries whose share of non-ASCII characters exceeds this
    // percentage (0-100) — a cheap heuristic for spam/attack payloads.
    maxNonAsciiPercent: parseFloat(process.env.POLICY_MAX_NON_ASCII_PERCENT || '50'),
  },
}
