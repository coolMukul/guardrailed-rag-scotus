/**
 * ChatGroq with the free-tier rate limiter wired in as a pre-call gate.
 *
 * `_generate` is the single choke point that both `.invoke()` and
 * `.withStructuredOutput(...).invoke()` pass through for non-streaming
 * calls, so overriding it guards every Groq call in the pipeline
 * (generation, grounding judge, injection classifier) without per-call-site
 * wiring. Streaming is intentionally not used for Groq: it would bypass
 * this override via `_streamResponseChunks`.
 */

import { ChatGroq } from '@langchain/groq';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { limiterFor } from './rate-limiter.js';
import { estimateTokens } from '../util/tokens.js';

export class RateLimitedChatGroq extends ChatGroq {
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const limiter = limiterFor(this.model);

    // Budget = estimated input + the output cap, so a call never starts when
    // it could blow the per-minute token window mid-flight.
    const estimated =
      estimateTokens(messages.map((m) => ({ role: m.getType(), content: m.content }))) +
      (this.maxTokens ?? 256);
    await limiter.acquire(estimated);

    const result = await super._generate(messages, options, runManager);

    const usage = (result.generations[0]?.message as AIMessage | undefined)?.usage_metadata;
    const totalTokens =
      usage?.total_tokens ?? (result.llmOutput?.tokenUsage?.totalTokens as number | undefined) ?? 0;
    if (totalTokens > 0) limiter.recordTokens(totalTokens);

    return result;
  }
}
