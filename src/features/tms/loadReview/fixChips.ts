/** Roughly how many characters of fix chips fit on one line of the What to fix column at its default width. */
export const FIX_CHARS_PER_LINE = 56

/** How many lines a list of fix chips wraps to in the What to fix column. */
export function fixLinesOf(items: readonly string[]): number {
  let lines = 1, used = 0
  for (const item of items) {
    const len = item.length + 3
    if (used > 0 && used + len > FIX_CHARS_PER_LINE) { lines += 1 + Math.floor(len / FIX_CHARS_PER_LINE); used = len % FIX_CHARS_PER_LINE } else used += len
  }
  return lines
}

/** What to fix rows stay short (Ryne 2026-11-16: the tall rows made the page hard to scroll): this many lines of chips per density. */
export const FIX_LINE_LIMIT: Record<'compact' | 'comfortable', number> = { compact: 2, comfortable: 3 }

/**
 * The chips that fit in `lines` lines, plus how many are left over. Nothing is lost: the leftover count reads "+N more",
 * the cell's tooltip lists every item, and a click opens the rail, which shows them all.
 */
export function fitFixItems(items: readonly string[], lines: number): { shown: string[]; hidden: number } {
  const shown: string[] = []
  for (let i = 0; i < items.length; i += 1) {
    const next = [...shown, items[i]]
    const rest = items.length - next.length
    // Leave room for the "+N more" chip when something will still be left over.
    if (fixLinesOf(rest > 0 ? [...next, `+${rest} more`] : next) > lines && shown.length > 0) break
    shown.push(items[i])
  }
  return { shown, hidden: items.length - shown.length }
}
