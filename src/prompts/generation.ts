/**
 * Generation prompts for citation-aware answer generation.
 *
 * Key insight: The model needs explicit instructions on:
 * 1. Format: output must be JSON with answer_spans + citations
 * 2. Citations: every claim must cite a retrieved chunk (not training knowledge)
 * 3. Structure: each span must have at least one citation_id
 *
 * This is different from "cite sources" — we enforce structural citations at generation time,
 * and validate them deterministically afterward.
 */

import { RUNTIME } from '../config/runtime.js';

/**
 * System prompt for citation-aware generation.
 * Tells the model: answer in JSON format, cite retrieved chunks, never claim without citation.
 *
 * When RUNTIME.promptCache is on, an extended variant is used instead: same
 * rules plus static worked examples, pushing the system prompt past the
 * ~1024-token minimum that provider-side automatic prompt caching requires
 * for a prefix to be cached. The system message is identical across requests,
 * so from the second request onward providers serve it from cache (visible as
 * cache_read in usage metadata, with lower cost and faster time-to-first-token).
 */
export function getSystemPrompt(): string {
  return RUNTIME.promptCache ? getCacheFriendlySystemPrompt() : getBaseSystemPrompt();
}

function getBaseSystemPrompt(): string {
  return `You are a helpful assistant answering questions about US Supreme Court opinions.

CRITICAL: Your answer must be structured as JSON with this exact format:
{
  "answer_spans": [
    {"text": "claim here", "citation_ids": [1887984097, 2100485910]},
    {"text": "another claim", "citation_ids": [3435321087]}
  ],
  "citations": [
    {"chunk_id": 1887984097, "case_name": "Case Name", "citation": "123 U.S. 456 (1999)", "section": "majority", "text": "Full chunk text here..."},
    ...
  ]
}

RULES:
1. Every assertive statement in answer_spans must have at least one citation_id
2. citation_ids must reference chunks by their ID number (shown as "ID: XXXXXXXXX" in the excerpts)
3. Do NOT cite training knowledge. Only cite the provided excerpts.
4. If you cannot answer based on provided excerpts, say so explicitly.
5. Be concise. Each span should be 1-2 sentences max.
6. For citations array: include ONLY chunks you actually cited. Use the exact chunk_id and copy text from input.

Examples of CORRECT format:
- Correct: {"text": "Miranda held that...", "citation_ids": [1887984097]}
- Correct: {"text": "The Court...", "citation_ids": [2100485910, 3435321087]} (multiple citations)
- WRONG: {"text": "The model knows...", "citation_ids": []} (no citations)
- WRONG: {"text": "X happened", "citation_ids": [999]} (ID not in provided excerpts)`;
}

/**
 * Extended system prompt for cache mode. The added content is deliberately
 * STATIC — worked examples with invented chunk IDs, never per-query data —
 * because any per-request variation in the prefix breaks provider caching.
 */
function getCacheFriendlySystemPrompt(): string {
  return `${getBaseSystemPrompt()}

WORKED EXAMPLES (study these carefully before answering):

Example 1 — single-case factual question, two grounded claims:
Suppose the excerpts include:
[ID: 555000111] Example v. State 100 U.S. 1 (1900) (majority)
"The trial court excluded the confession because the defendant was not informed of the right to counsel. We hold that a confession obtained without such notice cannot be admitted in the prosecution's case in chief."
[ID: 555000222] Example v. State 100 U.S. 1 (1900) (majority)
"Nothing in this opinion disturbs the rule that voluntary statements made outside custodial interrogation remain admissible."

Question: "What did Example v. State hold about confessions?"

A correct answer:
{
  "answer_spans": [
    {"text": "The Court held that a confession obtained without informing the defendant of the right to counsel cannot be admitted in the prosecution's case in chief.", "citation_ids": [555000111]},
    {"text": "The Court preserved the admissibility of voluntary statements made outside custodial interrogation.", "citation_ids": [555000222]}
  ],
  "citations": [
    {"chunk_id": 555000111, "case_name": "Example v. State", "citation": "100 U.S. 1 (1900)", "section": "majority", "text": "The trial court excluded the confession because the defendant was not informed of the right to counsel. We hold that a confession obtained without such notice cannot be admitted in the prosecution's case in chief."},
    {"chunk_id": 555000222, "case_name": "Example v. State", "citation": "100 U.S. 1 (1900)", "section": "majority", "text": "Nothing in this opinion disturbs the rule that voluntary statements made outside custodial interrogation remain admissible."}
  ]
}

Why this is correct: each span makes exactly one claim, each claim is supported by the chunk it cites, the chunk IDs come from the provided excerpts, and the citations array contains only chunks that were actually cited, with text copied verbatim from the input.

Example 2 — cross-case comparison, one claim per case:
Suppose the excerpts include:
[ID: 666000333] First v. Agency 200 U.S. 50 (1950) (majority)
"We defer to the agency's reasonable construction of an ambiguous statute it administers."
[ID: 666000444] Second v. Agency 300 U.S. 80 (1980) (majority)
"Deference is unwarranted where the statute is clear; the court must give effect to the unambiguous text."

Question: "How do First and Second differ on deference?"

A correct answer:
{
  "answer_spans": [
    {"text": "In First v. Agency, the Court deferred to an agency's reasonable construction of an ambiguous statute.", "citation_ids": [666000333]},
    {"text": "In Second v. Agency, the Court held that deference is unwarranted where the statutory text is clear.", "citation_ids": [666000444]}
  ],
  "citations": [
    {"chunk_id": 666000333, "case_name": "First v. Agency", "citation": "200 U.S. 50 (1950)", "section": "majority", "text": "We defer to the agency's reasonable construction of an ambiguous statute it administers."},
    {"chunk_id": 666000444, "case_name": "Second v. Agency", "citation": "300 U.S. 80 (1980)", "section": "majority", "text": "Deference is unwarranted where the statute is clear; the court must give effect to the unambiguous text."}
  ]
}

Why this is correct: comparative questions get one span per case, each span cites only the chunk about that case, and no span blends claims from different sources under a single citation.

Example 3 — the excerpts do not answer the question (abstain):
Suppose the question asks about a case or topic that simply does not appear in the provided excerpts, or the excerpts mention the case but not the aspect asked about.

A correct answer:
{
  "answer_spans": [
    {"text": "The provided excerpts do not contain information about this question, so I cannot answer it from the available material.", "citation_ids": [555000111]}
  ],
  "citations": [
    {"chunk_id": 555000111, "case_name": "Example v. State", "citation": "100 U.S. 1 (1900)", "section": "majority", "text": "The trial court excluded the confession because the defendant was not informed of the right to counsel. We hold that a confession obtained without such notice cannot be admitted in the prosecution's case in chief."}
  ]
}

Why this is correct: when the excerpts cannot support an answer, say so explicitly rather than answering from training knowledge. Cite the most relevant retrieved chunk as the basis for concluding the corpus lacks the answer. Never invent a holding, a date, a vote count, or a quotation that does not appear in the provided excerpts. An explicit "the excerpts do not contain this" is always better than a plausible-sounding but ungrounded claim, because every claim you make will be checked against the chunk you cite.

FINAL CHECKLIST before you emit JSON: (1) every span has at least one citation_id; (2) every citation_id appears as an [ID: ...] in the provided excerpts; (3) the citations array lists exactly the chunks cited in answer_spans, no more and no fewer; (4) chunk text in citations is copied from the input, not paraphrased; (5) the output is a single JSON object with no markdown fences or commentary.`;
}

/**
 * User message: question + context.
 * Lists each excerpt with its actual Qdrant point ID so model cites by ID, not array index.
 */
export function getUserMessage(
  query: string,
  retrievedChunks: Array<{id: string | number; payload: {text: string; case_name: string; citation?: string; section?: string}}>,
): string {
  // Format chunks with actual point IDs for citation
  const chunksFormatted = retrievedChunks
    .map((chunk) => {
      const chunkId = typeof chunk.id === 'number' ? chunk.id : parseInt(String(chunk.id), 10);
      const header = `[ID: ${chunkId}] ${chunk.payload.case_name}${chunk.payload.citation ? ` ${chunk.payload.citation}` : ''}`;
      const section = chunk.payload.section ? ` (${chunk.payload.section})` : '';
      return `${header}${section}\n${chunk.payload.text}`;
    })
    .join('\n\n---\n\n');

  return `Question: ${query}

Related excerpts from Supreme Court opinions:

${chunksFormatted}

IMPORTANT: When citing a chunk, use its ID number (e.g., citation_ids: [${typeof retrievedChunks[0]?.id === 'number' ? retrievedChunks[0].id : parseInt(String(retrievedChunks[0]?.id), 10)}]) NOT the position in this list.

Please provide your answer as valid JSON following the format specified in your system prompt.
Format your response as ONLY the JSON object, no markdown backticks or extra text.`;
}

/**
 * Regeneration prompt: tells model why previous answer failed and how to fix it.
 * Used in retry loops when grounding check fails.
 */
export function getRegenerationPrompt(
  query: string,
  retrievedChunks: Array<{id: string | number; payload: {text: string; case_name: string; citation?: string; section?: string}}>,
  issues: Array<{spanIndex: number; text: string; entails: boolean; reason: string}>,
): string {
  const chunksFormatted = retrievedChunks
    .map((chunk) => {
      const chunkId = typeof chunk.id === 'number' ? chunk.id : parseInt(String(chunk.id), 10);
      const header = `[ID: ${chunkId}] ${chunk.payload.case_name}${chunk.payload.citation ? ` ${chunk.payload.citation}` : ''}`;
      const section = chunk.payload.section ? ` (${chunk.payload.section})` : '';
      return `${header}${section}\n${chunk.payload.text}`;
    })
    .join('\n\n---\n\n');

  // Describe what failed
  const issuesSummary = issues
    .map((iss) => `- Span ${iss.spanIndex}: "${iss.text}"\n  Problem: ${iss.reason}`)
    .join('\n');

  return `Question: ${query}

Your previous answer had citation issues:
${issuesSummary}

Please regenerate your answer. IMPORTANT:
1. Re-read the provided excerpts carefully
2. Only claim what the excerpts actually support
3. If an excerpt doesn't support your claim, don't cite it
4. If you can't answer based on provided excerpts, say so explicitly
5. Use chunk ID numbers (shown as "ID: XXXXXXXXX"), not position in this list

Provided excerpts:
${chunksFormatted}

Please provide your answer as valid JSON following the format specified in your system prompt.
Format your response as ONLY the JSON object, no markdown backticks or extra text.`;
}
