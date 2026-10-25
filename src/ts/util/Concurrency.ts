/**
 * Runs an async worker over the given items with a bounded number of in-flight
 * calls. Results keep the input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const concurrency = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}
