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
