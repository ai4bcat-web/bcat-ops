/**
 * Like `Promise.all(items.map(fn))`, but at most `limit` calls are in flight at once and
 * results keep input order. Rejects with the first failure (remaining items are not started).
 * Use it for per-row reads over a whole list: an unbounded fan-out exhausts the browser's
 * socket budget (net::ERR_INSUFFICIENT_RESOURCES).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
