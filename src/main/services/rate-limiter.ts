/**
 * Adaptive rate limiter for LLM API calls.
 *
 * Coordinates concurrency across parallel requests to avoid thundering herd
 * on 429 rate-limit responses. Halves concurrency on rate limits, recovers
 * gradually on success streaks.
 */

export interface RateLimiterOptions {
  /** Starting concurrency (default: 8) */
  initialConcurrency: number;
  /** Floor — never go below this (default: 1) */
  minConcurrency: number;
  /** Ceiling — never exceed this (default: initialConcurrency) */
  maxConcurrency: number;
  /** Consecutive successes needed before increasing concurrency by 1 (default: 5) */
  recoveryThreshold: number;
}

const DEFAULTS: RateLimiterOptions = {
  initialConcurrency: 8,
  minConcurrency: 1,
  maxConcurrency: 8,
  recoveryThreshold: 5,
};

/**
 * Adaptive rate limiter that controls how many concurrent LLM requests
 * can be in flight. Callers acquire a slot before making a request and
 * release it after, reporting success or rate-limit.
 */
export class AdaptiveRateLimiter {
  private concurrency: number;
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly recoveryThreshold: number;

  private inFlight = 0;
  private consecutiveSuccesses = 0;
  private waitQueue: Array<() => void> = [];

  constructor(opts?: Partial<RateLimiterOptions>) {
    const config = { ...DEFAULTS, ...opts };
    this.concurrency = config.initialConcurrency;
    this.minConcurrency = config.minConcurrency;
    this.maxConcurrency = config.maxConcurrency;
    this.recoveryThreshold = config.recoveryThreshold;
  }

  /** Current concurrency limit. */
  get currentConcurrency(): number {
    return this.concurrency;
  }

  /** Number of requests currently in flight. */
  get currentInFlight(): number {
    return this.inFlight;
  }

  /**
   * Acquire a concurrency slot. Resolves when a slot is available.
   * Returns a release function that MUST be called after the request
   * completes, passing the outcome.
   */
  async acquire(): Promise<ReleaseFunction> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return this.createRelease();
    }

    // Wait for a slot to open (inFlight is pre-incremented by drainQueue)
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });

    return this.createRelease();
  }

  private createRelease(): ReleaseFunction {
    let released = false;

    return (outcome: 'success' | 'rate_limited') => {
      if (released) return;
      released = true;

      this.inFlight--;

      if (outcome === 'rate_limited') {
        this.onRateLimit();
      } else {
        this.onSuccess();
      }

      // Wake a waiter if there's capacity
      this.drainQueue();
    };
  }

  private onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    const newConcurrency = Math.max(
      this.minConcurrency,
      Math.floor(this.concurrency / 2)
    );
    if (newConcurrency < this.concurrency) {
      console.warn(
        `[RateLimiter] 429 detected — reducing concurrency ${this.concurrency} → ${newConcurrency}`
      );
      this.concurrency = newConcurrency;
    }
  }

  private onSuccess(): void {
    this.consecutiveSuccesses++;
    if (
      this.consecutiveSuccesses >= this.recoveryThreshold &&
      this.concurrency < this.maxConcurrency
    ) {
      this.concurrency++;
      this.consecutiveSuccesses = 0;
      console.log(
        `[RateLimiter] Success streak — increasing concurrency to ${this.concurrency}`
      );
    }
  }

  private drainQueue(): void {
    while (this.waitQueue.length > 0 && this.inFlight < this.concurrency) {
      const next = this.waitQueue.shift();
      if (next) {
        // Pre-increment inFlight so the loop correctly limits how many waiters we wake
        this.inFlight++;
        next();
      }
    }
  }
}

export type ReleaseFunction = (outcome: 'success' | 'rate_limited') => void;

/**
 * Execute a batch of tasks with adaptive rate limiting.
 *
 * Unlike a fixed-size batch loop (`for i += BATCH_SIZE`), this submits
 * tasks as fast as the limiter allows — maximizing throughput while
 * respecting rate limits.
 *
 * @param items - Items to process
 * @param limiter - Shared rate limiter
 * @param fn - Async function to run for each item. Receives item + index.
 *             Must throw an error with `statusCode === 429` to signal rate limiting.
 * @returns Results in the same order as items, with { value } or { error }.
 */
export async function executeWithRateLimiter<T, R>(
  items: T[],
  limiter: AdaptiveRateLimiter,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<{ value?: R; error?: unknown }>> {
  const results: Array<{ value?: R; error?: unknown }> = new Array(items.length);

  const tasks = items.map(async (item, index) => {
    const release = await limiter.acquire();
    try {
      const value = await fn(item, index);
      release('success');
      results[index] = { value };
    } catch (err: unknown) {
      const isRateLimit = isRateLimitError(err);
      release(isRateLimit ? 'rate_limited' : 'success');
      results[index] = { error: err };
    }
  });

  await Promise.all(tasks);
  return results;
}

/** Check if an error represents a 429 rate limit. */
function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    return (err as { statusCode: number }).statusCode === 429;
  }
  return false;
}
