import { describe, it, expect } from 'vitest';
import { runPool } from '../../../src/main/utils/concurrency-pool';

describe('runPool', () => {
  it('should run all tasks and return results in order', async () => {
    const tasks = [
      async () => 'a',
      async () => 'b',
      async () => 'c',
    ];

    const results = await runPool(tasks, 2);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should respect concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 10 }, () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return 'done';
    });

    await runPool(tasks, 3);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('should stop processing when isStopped returns true', async () => {
    let completed = 0;
    let stopped = false;

    const tasks = Array.from({ length: 10 }, () => async () => {
      completed++;
      if (completed >= 3) stopped = true;
      return completed;
    });

    await runPool(tasks, 1, () => stopped);
    expect(completed).toBeLessThan(10);
  });

  it('should handle empty task list', async () => {
    const results = await runPool([], 5);
    expect(results).toEqual([]);
  });

  it('should propagate errors from tasks', async () => {
    const tasks = [
      async () => 'ok',
      async () => { throw new Error('fail'); },
    ];

    await expect(runPool(tasks, 2)).rejects.toThrow('fail');
  });
});
