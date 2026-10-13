/**
 * Shared ordering for the calendar day/week/month views.
 *
 * Load.sortOrder is a HIDDEN persisted per-day drag position (never shown to the user).
 * Sorting every view by sortOrder first means a manual drag-order survives navigation
 * and is identical across day/week/month. Loads without a sortOrder fall back to their
 * appointment time. (Load.daySlot is a separate VISIBLE manual number badge and does
 * NOT affect ordering.)
 */

/** Comparator: sortOrder ascending (positioned loads first), then a time fallback. */
export function compareByOrder<T>(
  orderOf: (e: T) => number | null | undefined,
  timeOf: (e: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    const sa = orderOf(a)
    const sb = orderOf(b)
    if (sa != null && sb != null && sa !== sb) return sa - sb
    if (sa != null && sb == null) return -1
    if (sa == null && sb != null) return 1
    return timeOf(a).localeCompare(timeOf(b))
  }
}

/**
 * Persist a day's new drag order by writing sequential sortOrder (1..N) to each load,
 * skipping loads already at the right value. sortOrder is hidden, so this never shows a
 * number to the user. Call on drop after a within-day reorder.
 */
export function persistDragOrder(
  orderedLoadIds: string[],
  currentOrder: (loadId: string) => number | null | undefined,
  updateLoad: (id: string, patch: { sortOrder: number }) => void,
): void {
  orderedLoadIds.forEach((id, i) => {
    if (currentOrder(id) !== i + 1) updateLoad(id, { sortOrder: i + 1 })
  })
}

/**
 * A day's rows with each driver's loads stacked together, in slot order.
 *
 * `rows` arrive already sorted (drag position, then time). Each driver's rows are pulled
 * together at the position of their first row and ordered by the slot badge (the number
 * the office gave the load for that driver: 1, 2, 3…), slotless ones after, in their
 * original order. Rows with no driver keep their place. The first row of each group is
 * returned too, so every row in the group can take its colour.
 */
export function groupRowsByDriver<T>(
  rows: readonly T[],
  driverOf: (row: T) => string | null | undefined,
  slotOf: (row: T) => number | null | undefined,
): { rows: T[]; firstByDriver: Map<string, T> } {
  const byDriver = new Map<string, T[]>()
  const order: Array<{ driver: string } | { row: T }> = []
  for (const row of rows) {
    const driver = driverOf(row) ?? null
    if (!driver) { order.push({ row }); continue }
    const group = byDriver.get(driver)
    if (group) group.push(row)
    else { byDriver.set(driver, [row]); order.push({ driver }) }
  }
  const slotRank = (row: T) => { const s = slotOf(row); return typeof s === 'number' && Number.isFinite(s) ? s : Number.MAX_SAFE_INTEGER }
  const out: T[] = []
  const firstByDriver = new Map<string, T>()
  for (const item of order) {
    if ('row' in item) { out.push(item.row); continue }
    const group = byDriver.get(item.driver)!
      .map((row, i) => ({ row, i }))
      .sort((a, b) => slotRank(a.row) - slotRank(b.row) || a.i - b.i)
      .map((x) => x.row)
    firstByDriver.set(item.driver, group[0])
    out.push(...group)
  }
  return { rows: out, firstByDriver }
}
