/**
 * Runs a worker over items with a bounded number in flight at once.
 *
 * A pull request of hundreds of files would otherwise be fetched one at a time; a
 * small pool keeps the network busy without opening a connection per file. Results
 * keep the input order, and a cancelled run stops pulling new work.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  isCancelled: () => boolean = () => false,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length || 1));

  async function run(): Promise<void> {
    for (;;) {
      if (isCancelled()) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()));
  return results;
}
