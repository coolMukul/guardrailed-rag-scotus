/**
 * Deterministic corpus-scope guard.
 *
 * The strict out-of-corpus contract: if the question is about a specific named
 * case (PARTY v. PARTY) and that case's own opinion is not in the retrieved
 * set, the SUT must abstain — even when a related in-corpus opinion recites the
 * holding (which is how prompt-only enforcement leaked: the claim WAS entailed
 * by the other chunk, so grounding passed).
 *
 * This check is deterministic and runs before generation, so an out-of-corpus
 * named case short-circuits to abstention without spending generate/judge calls.
 *
 * It is intentionally biased toward NOT abstaining, in two ways:
 *   1. A case counts as present when a retrieved case_name carries both party
 *      surnames — so an answerable in-corpus question is never false-abstained.
 *   2. Each named case is judged INDEPENDENTLY, and the guard fires only when
 *      EVERY named case is absent. A comparative names two different cases that
 *      live in different chunks; requiring one chunk to satisfy all of them at
 *      once false-abstained almost the entire comparative category. So as long
 *      as any named case is present, we proceed to generation and let retrieval
 *      + per-span grounding handle the rest.
 * Questions with no "PARTY v. PARTY" reference are left untouched (the
 * generation prompt rule is the backstop there).
 */

import type { SearchResult } from '../retrieval/qdrant-client.js';

/**
 * Version of the corpus-scope guard logic. Folded into the config fingerprint
 * because the guard's verdict is a scored eval outcome (forced abstention), so a
 * behavior change here must invalidate cross-run comparisons even when no config
 * VALUE changes. v2 fixes the multi-case false-abstention: parties no longer
 * absorb 'and'/'&', and the guard fires only when every named case is absent.
 */
export const CORPUS_SCOPE_VERSION = 'corpus-scope-v2';

export interface CorpusScopeResult {
  outOfCorpus: boolean;
  /** The named case judged absent from the retrieved set, when outOfCorpus. */
  namedCase?: string;
}

interface CaseRef {
  full: string;
  left: string;
  right: string;
}

// "PARTY v. PARTY" — a party is a Title-Case run: a capitalized token followed
// by more capitalized tokens or lowercase legal connectors (of/the/for).
// Crucially it does NOT absorb arbitrary lowercase words, so surrounding query
// text ("What did <case> hold?") is excluded from the party — otherwise the
// party's last token becomes a trailing verb and matching breaks.
// 'and'/'&' are deliberately NOT connectors: in a comparative like
// "SEC v. Jarkesy and Loper Bright", treating 'and' as a connector merged the
// second case into the first party ("Jarkesy and Loper Bright"), which no chunk
// could ever match → false abstention on every comparative.
// Requires " v. " / " v " as the separator (a real party divider), never "vs"
// (a comparison), so a comparative query isn't mistaken for one named case.
const PARTY = `[A-Z][A-Za-z.'&-]*(?:\\s+(?:of|the|for|[A-Z][A-Za-z.'&-]*))*`;
const CASE_REF = new RegExp(`(${PARTY})\\s+v\\.?\\s+(${PARTY})`, 'g');

// Capitalized words that begin a question/clause, not a party name, and that the
// Title-Case party pattern can absorb at a sentence boundary. Stripped from the
// left party so the displayed case name reads cleanly (matching uses the last
// token regardless, so this is presentation only).
const LEADING_STOPWORDS = new Set([
  'in', 'the', 'under', 'per', 'see', 'compare', 'what', 'how', 'did', 'does',
  'was', 'were', 'when', 'where', 'why', 'who', 'which', 'is', 'are', 'about',
]);

function stripLeadingStopwords(party: string): string {
  const tokens = party.split(/\s+/);
  while (tokens.length > 1 && LEADING_STOPWORDS.has((tokens[0] ?? '').toLowerCase())) {
    tokens.shift();
  }
  return tokens.join(' ');
}

export function extractNamedCases(query: string): CaseRef[] {
  const refs: CaseRef[] = [];
  for (const m of query.matchAll(CASE_REF)) {
    const left = stripLeadingStopwords((m[1] ?? '').trim());
    const right = (m[2] ?? '').trim();
    if (left && right) refs.push({ full: `${left} v. ${right}`, left, right });
  }
  return refs;
}

/** Last alphanumeric token of a party name, lowercased (the distinctive surname/acronym). */
function surname(party: string): string {
  const tokens = party.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens[tokens.length - 1] ?? '';
}

export function checkCorpusScope(
  query: string,
  retrievedChunks: Array<{ payload: { case_name: string } }>,
): CorpusScopeResult {
  const named = extractNamedCases(query);
  if (named.length === 0) return { outOfCorpus: false };

  const retrievedNames = retrievedChunks.map((c) => (c.payload.case_name || '').toLowerCase());

  const absent: string[] = [];
  let anyPresent = false;

  for (const ref of named) {
    const left = surname(ref.left);
    const right = surname(ref.right);
    if (!left || !right) {
      // Can't judge this ref confidently — treat as present (fail safe toward answering).
      anyPresent = true;
      continue;
    }

    // Present iff some retrieved case_name carries BOTH party surnames.
    const present = retrievedNames.some((n) => n.includes(left) && n.includes(right));
    if (present) anyPresent = true;
    else absent.push(ref.full);
  }

  // Force-abstain ONLY when every named case is absent — i.e. there is no
  // in-corpus case to answer from. If any named case is present (the common
  // case for in-corpus single questions and for comparatives), proceed.
  if (!anyPresent && absent.length > 0) {
    return { outOfCorpus: true, namedCase: absent.join('; ') };
  }

  return { outOfCorpus: false };
}
