// =========================================================
// Bounded-concurrency async map.
// 
// Runs `fn` over `items` with at most `limit` tasks in flight, preserving input
// order in the results. Use instead of Promise.all when each task hits the
// network (e.g. translating every word in a paragraph) so a big input can't
// fire hundreds of requests at once.
// =========================================================

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount =
    items.length === 0 ? 0 : Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
