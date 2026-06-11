/**
 * Client-side sliding-window rate limiter for the Groq free tier.
 *
 * Tracks requests-per-minute, requests-per-day, tokens-per-minute, and
 * tokens-per-day against the published free-tier limits and makes callers
 * wait (or throw, for daily caps) before the API would reject them.
 *
 * Trade-off: the windows are purely local. The underlying groq-sdk retries
 * 429s honoring Retry-After, so if another process shares the same key and
 * drains the server-side budget, the SDK's retry handles it — but this
 * limiter's daily counters can undercount in that scenario.
 */

export interface ModelLimits {
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
}

/** Published Groq free-tier limits for the models this project uses. */
export const FREE_TIER_LIMITS: Record<string, ModelLimits> = {
  'llama-3.3-70b-versatile': { rpm: 30, rpd: 1_000, tpm: 12_000, tpd: 100_000 },
  'llama-3.1-8b-instant': { rpm: 30, rpd: 14_400, tpm: 6_000, tpd: 500_000 },
  'meta-llama/llama-prompt-guard-2-86m': { rpm: 30, rpd: 14_400, tpm: 15_000, tpd: 500_000 },
};

/** Conservative default for models without a published entry above. */
const DEFAULT_LIMITS: ModelLimits = FREE_TIER_LIMITS['llama-3.3-70b-versatile']!;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface LimiterSnapshot {
  label: string;
  rpmUsed: number;
  rpmLimit: number;
  rpdUsed: number;
  rpdLimit: number;
  tpmUsed: number;
  tpmLimit: number;
  tpdUsed: number;
  tpdLimit: number;
}

export class RateLimiter {
  private requestTimes: number[] = [];
  private tokenEvents: { t: number; tokens: number }[] = [];
  private dayStart = Date.now();
  private dayCount = 0;
  private dayTokens = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly label: string,
    private readonly limits: ModelLimits,
  ) {}

  async acquire(estimatedTokens = 0): Promise<void> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    try {
      await prev;
      await this.waitForSlot(estimatedTokens);
    } finally {
      release();
    }
  }

  recordTokens(tokens: number): void {
    if (tokens <= 0) return;
    this.tokenEvents.push({ t: Date.now(), tokens });
    this.dayTokens += tokens;
  }

  snapshot(): LimiterSnapshot {
    const now = Date.now();
    this.prune(now);
    this.rollDay(now);
    return {
      label: this.label,
      rpmUsed: this.requestTimes.length,
      rpmLimit: this.limits.rpm,
      rpdUsed: this.dayCount,
      rpdLimit: this.limits.rpd,
      tpmUsed: this.tokensInWindow(),
      tpmLimit: this.limits.tpm,
      tpdUsed: this.dayTokens,
      tpdLimit: this.limits.tpd,
    };
  }

  private async waitForSlot(estimatedTokens: number): Promise<void> {
    while (true) {
      const now = Date.now();
      this.prune(now);
      this.rollDay(now);

      if (this.dayCount >= this.limits.rpd) {
        throw new Error(
          `[rate-limiter:${this.label}] daily request limit reached (${this.limits.rpd}/day).`,
        );
      }

      if (estimatedTokens > 0 && this.dayTokens + estimatedTokens > this.limits.tpd) {
        throw new Error(
          `[rate-limiter:${this.label}] daily token limit reached (${this.limits.tpd}/day).`,
        );
      }

      if (this.requestTimes.length >= this.limits.rpm) {
        const oldest = this.requestTimes[0]!;
        await sleep(oldest + MINUTE_MS - now + 50);
        continue;
      }

      if (estimatedTokens > 0) {
        const used = this.tokensInWindow();
        if (used + estimatedTokens > this.limits.tpm) {
          const oldest = this.tokenEvents[0];
          const wait = oldest ? oldest.t + MINUTE_MS - now + 50 : 1_000;
          await sleep(wait);
          continue;
        }
      }

      this.requestTimes.push(now);
      this.dayCount++;
      return;
    }
  }

  private prune(now: number): void {
    const cutoff = now - MINUTE_MS;
    while (this.requestTimes.length && this.requestTimes[0]! < cutoff) {
      this.requestTimes.shift();
    }
    while (this.tokenEvents.length && this.tokenEvents[0]!.t < cutoff) {
      this.tokenEvents.shift();
    }
  }

  private rollDay(now: number): void {
    if (now - this.dayStart >= DAY_MS) {
      this.dayStart = now;
      this.dayCount = 0;
      this.dayTokens = 0;
    }
  }

  private tokensInWindow(): number {
    let sum = 0;
    for (const e of this.tokenEvents) sum += e.tokens;
    return sum;
  }
}

const limiters = new Map<string, RateLimiter>();

/** One limiter per model so each model's windows are tracked independently. */
export function limiterFor(model: string): RateLimiter {
  let l = limiters.get(model);
  if (!l) {
    l = new RateLimiter(model, FREE_TIER_LIMITS[model] ?? DEFAULT_LIMITS);
    limiters.set(model, l);
  }
  return l;
}
