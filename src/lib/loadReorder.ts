/**
 * New sortOrder values for loads a driver dragged into a new order.
 *
 * Load.sortOrder is one number line shared by every driver's loads on a day (the calendar
 * writes 1..N across the whole day), so a driver cannot renumber 1..N without jumping
 * other drivers' loads. Instead the loads re-use the values they already hold, handed out
 * in the new order: the set of positions is unchanged, only who sits in which moves. A
 * load with no value yet takes the next numbers above the largest one in the set.
 *
 * Shared by the driver API (which writes them) and the phone (which shows them before the
 * write lands, and so matches the schedule fingerprint the server will produce).
 */
export function reorderedSortValues(
  ordered: ReadonlyArray<{ id: string; sortOrder?: number | null }>,
): Map<string, number> {
  const pool = [...new Set(ordered.map((l) => l.sortOrder).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))]
    .sort((a, b) => a - b)
  let next = pool.length ? pool[pool.length - 1] : 0
  while (pool.length < ordered.length) pool.push(++next)
  return new Map(ordered.map((l, i) => [l.id, pool[i]]))
}
