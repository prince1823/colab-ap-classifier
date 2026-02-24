import { describe, it, expect, vi } from 'vitest';
import {
  AdaptiveRateLimiter,
  executeWithRateLimiter,
} from '../../../src/main/services/rate-limiter';

describe('AdaptiveRateLimiter', () => {
  it('should start with configured concurrency', () => {
    const limiter = new AdaptiveRateLimiter({ initialConcurrency: 4 });
    expect(limiter.currentConcurrency).toBe(4);
    expect(limiter.currentInFlight).toBe(0);
  });

  it('should allow acquiring up to concurrency limit', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 2,
    });

    const release1 = await limiter.acquire();
    const release2 = await limiter.acquire();

    expect(limiter.currentInFlight).toBe(2);

    release1('success');
    release2('success');
    expect(limiter.currentInFlight).toBe(0);
  });

  it('should halve concurrency on rate limit', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 8,
      minConcurrency: 1,
      maxConcurrency: 8,
    });

    expect(limiter.currentConcurrency).toBe(8);

    const release = await limiter.acquire();
    release('rate_limited');

    expect(limiter.currentConcurrency).toBe(4);
  });

  it('should not go below minConcurrency on rate limit', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 2,
    });

    // Halve: 2 → 1
    let release = await limiter.acquire();
    release('rate_limited');
    expect(limiter.currentConcurrency).toBe(1);

    // Halve again: should stay at 1 (floor)
    release = await limiter.acquire();
    release('rate_limited');
    expect(limiter.currentConcurrency).toBe(1);
  });

  it('should increase concurrency after recovery threshold successes', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 4,
      minConcurrency: 1,
      maxConcurrency: 8,
      recoveryThreshold: 3,
    });

    // First reduce concurrency
    let release = await limiter.acquire();
    release('rate_limited');
    expect(limiter.currentConcurrency).toBe(2);

    // 3 successes → should recover to 3
    for (let i = 0; i < 3; i++) {
      release = await limiter.acquire();
      release('success');
    }
    expect(limiter.currentConcurrency).toBe(3);
  });

  it('should not exceed maxConcurrency during recovery', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 4,
      minConcurrency: 1,
      maxConcurrency: 4,
      recoveryThreshold: 1,
    });

    // Already at max — successes shouldn't increase further
    const release = await limiter.acquire();
    release('success');
    expect(limiter.currentConcurrency).toBe(4);
  });

  it('should reset consecutive successes on rate limit', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 4,
      minConcurrency: 1,
      maxConcurrency: 8,
      recoveryThreshold: 3,
    });

    // Reduce to 2
    let release = await limiter.acquire();
    release('rate_limited');
    expect(limiter.currentConcurrency).toBe(2);

    // 2 successes (not enough for recovery)
    for (let i = 0; i < 2; i++) {
      release = await limiter.acquire();
      release('success');
    }
    expect(limiter.currentConcurrency).toBe(2);

    // Rate limit again — resets counter, reduces to 1
    release = await limiter.acquire();
    release('rate_limited');
    expect(limiter.currentConcurrency).toBe(1);
  });

  it('should queue waiters when at capacity', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 1,
      minConcurrency: 1,
      maxConcurrency: 1,
    });

    const release1 = await limiter.acquire();
    expect(limiter.currentInFlight).toBe(1);

    // This should block until release1 is called
    let acquired2 = false;
    const acquire2Promise = limiter.acquire().then((r) => {
      acquired2 = true;
      return r;
    });

    // Give microtasks a chance to run
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acquired2).toBe(false);

    release1('success');
    const release2 = await acquire2Promise;
    expect(acquired2).toBe(true);
    expect(limiter.currentInFlight).toBe(1);

    release2('success');
    expect(limiter.currentInFlight).toBe(0);
  });

  it('should not double-release', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 4,
      minConcurrency: 1,
      maxConcurrency: 4,
    });

    const release = await limiter.acquire();
    expect(limiter.currentInFlight).toBe(1);

    release('success');
    expect(limiter.currentInFlight).toBe(0);

    // Second call should be a no-op
    release('rate_limited');
    expect(limiter.currentInFlight).toBe(0);
    expect(limiter.currentConcurrency).toBe(4); // Should NOT have halved
  });
});

describe('executeWithRateLimiter', () => {
  it('should process all items and return results in order', async () => {
    const limiter = new AdaptiveRateLimiter({ initialConcurrency: 3 });
    const items = [1, 2, 3, 4, 5];

    const results = await executeWithRateLimiter(items, limiter, async (item) => {
      return item * 2;
    });

    expect(results).toEqual([
      { value: 2 },
      { value: 4 },
      { value: 6 },
      { value: 8 },
      { value: 10 },
    ]);
  });

  it('should capture errors without crashing', async () => {
    const limiter = new AdaptiveRateLimiter({ initialConcurrency: 2 });
    const items = [1, 2, 3];

    const results = await executeWithRateLimiter(items, limiter, async (item) => {
      if (item === 2) throw new Error('fail');
      return item;
    });

    expect(results[0]).toEqual({ value: 1 });
    expect(results[1].error).toBeDefined();
    expect(results[2]).toEqual({ value: 3 });
  });

  it('should signal rate_limited for 429 errors', async () => {
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 4,
      minConcurrency: 1,
      maxConcurrency: 4,
    });

    const items = [1, 2];

    await executeWithRateLimiter(items, limiter, async (item) => {
      if (item === 1) {
        const err = new Error('rate limited') as Error & { statusCode: number };
        err.statusCode = 429;
        throw err;
      }
      return item;
    });

    // Concurrency should have halved from 4 → 2 due to the 429
    expect(limiter.currentConcurrency).toBe(2);
  });

  it('should handle empty items array', async () => {
    const limiter = new AdaptiveRateLimiter({ initialConcurrency: 4 });
    const results = await executeWithRateLimiter([], limiter, async () => 'x');
    expect(results).toEqual([]);
  });

  it('should respect concurrency limit during execution', async () => {
    // Set recoveryThreshold very high so concurrency stays at 2 throughout
    const limiter = new AdaptiveRateLimiter({
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 2,
      recoveryThreshold: 100,
    });
    let maxConcurrent = 0;
    let current = 0;

    const items = Array.from({ length: 10 }, (_, i) => i);

    await executeWithRateLimiter(items, limiter, async () => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise((resolve) => setTimeout(resolve, 10));
      current--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
