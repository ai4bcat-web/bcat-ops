/**
 * The tab strip in the top bar (section tabs and the shipment lifecycle) always shows EVERY tab at once (Ryne 2026-11-16: "make it so
 * the tabs all show up instead of having to scroll? display them all fixed across the top of all pages"). Earlier (2026-11-15) the
 * row scrolled sideways with a fade when it did not fit; that hid tabs, so it is gone.
 *
 * - The strip always takes its own full-width line in the (sticky) top bar (`tms-topbar-tabs-own-row`), never beside the search box.
 * - When the tabs still do not fit that line, they compress step by step (`data-fit` on the strip) until they do:
 *     1 tighter padding · 2 smaller text · 3 long labels truncate with an ellipsis (the full name is the tab's tooltip).
 *   Count badges always stay visible. Nothing scrolls sideways and no tab is hidden.
 * - Phones (≤ 640px) wrap the tabs onto a second line instead of shrinking the text (responsive.css).
 */

export const OWN_ROW_CLASS = 'tms-topbar-tabs-own-row'

/** The compression steps, loosest first. 0 = normal. */
export const FIT_LEVELS = [0, 1, 2, 3] as const
export type FitLevel = (typeof FIT_LEVELS)[number]

/** The loosest step at which the strip fits, given what the row needs at each step. The last step always fits (labels truncate). */
export function fitLevel(neededAt: (level: FitLevel) => number, available: number): FitLevel {
  for (const level of FIT_LEVELS) {
    if (level === 3 || neededAt(level) <= available + 1) return level
  }
  return 3
}

/** Keeps the top bar's tab strip on its own line, every tab visible. Returns the cleanup. */
export function watchOneRowTabs(topbar: HTMLElement): () => void {
  const nav = topbar.querySelector<HTMLElement>('.tms-lifecycle')
  const list = nav?.querySelector<HTMLElement>('.tms-lifecycle-list')
  if (!nav || !list) return () => undefined

  topbar.classList.add(OWN_ROW_CLASS)

  const layout = (): void => {
    // Measure each step as laid out: set it, read the no-wrap list's scrollWidth (the width every tab needs at that step).
    const level = fitLevel((l) => {
      nav.setAttribute('data-fit', String(l))
      return list.scrollWidth
    }, list.clientWidth)
    nav.setAttribute('data-fit', String(level))
  }

  layout()
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => layout())
  ro?.observe(topbar)
  return () => {
    ro?.disconnect()
    topbar.classList.remove(OWN_ROW_CLASS)
    nav.removeAttribute('data-fit')
  }
}
