/**
 * Run async tasks with bounded concurrency.
 *
 * @param tasks - Array of async functions to run
 * @param concurrency - Maximum number of concurrent tasks
 * @param isStopped - Optional function that returns true to stop processing new tasks
 * @returns Array of results in the same order as tasks
 */
export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  isStopped?: () => boolean
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      if (isStopped?.()) break;
      const idx = nextIndex++;
      if (idx >= tasks.length) break;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
