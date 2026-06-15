/**
 * Shared ordering for the calendar day/week/month views.
 *
 * Load.daySlot is the PERSISTENT per-day display order (an integer; also editable via
 * the 1–5 badge picker). Sorting every view by daySlot first means a manual drag-order
 * survives navigation and is identical across day/week/month. Loads without a slot fall
 * back to their appointment time.
 */

/** Comparator: daySlot ascending (slotted first), then a time fallback. */
export function compareBySlot<T>(
  slotOf: (e: T) => number | null | undefined,
  timeOf: (e: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    const sa = slotOf(a)
    const sb = slotOf(b)
    if (sa != null && sb != null && sa !== sb) return sa - sb
    if (sa != null && sb == null) return -1
    if (sa == null && sb != null) return 1
    return timeOf(a).localeCompare(timeOf(b))
  }
}

/**
 * Persist a day's new manual order by writing sequential daySlot (1..N) to each load,
 * skipping loads already at the right slot. Call on drop after a within-day reorder.
 */
export function persistDaySlotOrder(
  orderedLoadIds: string[],
  currentSlot: (loadId: string) => number | null | undefined,
  updateLoad: (id: string, patch: { daySlot: number }) => void,
): void {
  orderedLoadIds.forEach((id, i) => {
    if (currentSlot(id) !== i + 1) updateLoad(id, { daySlot: i + 1 })
  })
}
