/**
 * Rough token estimation used for client-side rate budgeting.
 *
 * chars/4 is a deliberately cheap heuristic: the rate limiter only needs a
 * ballpark figure to decide whether a call fits the per-minute token window,
 * and overestimating slightly is safer than calling a tokenizer per request.
 */

export interface EstimatableMessage {
  role?: string;
  content: unknown;
}

export function estimateTokens(messages: EstimatableMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    chars += content.length + (m.role?.length ?? 0) + 4;
  }
  return Math.ceil(chars / 4);
}
