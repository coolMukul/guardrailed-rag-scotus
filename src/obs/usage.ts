/**
 * In-process token usage accumulator.
 *
 * LangChain's structured-output path returns the parsed object, not the API
 * response, so token counts have to be captured at the call site and collected
 * somewhere the eval runner can read them. Each LLM call records its usage
 * here; the eval runner calls resetUsage() before a question and
 * getUsageTotals() after, giving per-question token and cost attribution
 * across generation, grounding-judge, and retry calls.
 *
 * cachedInputTokens tracks provider-side prompt-cache hits (reported as
 * cache_read in LangChain's standardized input_token_details) — the signal
 * the prompt-caching sweep measures.
 */

export interface UsageRecord {
  /** Which pipeline stage made the call: 'generate', 'judge', 'regenerate'. */
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

let records: UsageRecord[] = [];

export function recordUsage(record: UsageRecord): void {
  records.push(record);
}

export function resetUsage(): void {
  records = [];
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  bySource: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

export function getUsageTotals(): UsageTotals {
  const totals: UsageTotals = {
    calls: records.length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    bySource: {},
  };

  for (const r of records) {
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cachedInputTokens += r.cachedInputTokens;
    const s = (totals.bySource[r.source] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    s.calls++;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

/**
 * Extract a UsageRecord from a LangChain AIMessage (the `raw` field returned
 * by withStructuredOutput({ includeRaw: true })). Returns zeros if the
 * provider did not report usage.
 */
export function usageFromMessage(source: string, model: string, message: any): UsageRecord {
  const u = message?.usage_metadata;
  return {
    source,
    model,
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cachedInputTokens: u?.input_token_details?.cache_read ?? 0,
  };
}
