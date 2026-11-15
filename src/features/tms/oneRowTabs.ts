/**
 * The tab strip in the top bar (section tabs and the shipment lifecycle) is always one row (Ryne 2026-11-15: "put all tabs like
 * these in one row for any page that has tabs"). It used to wrap to a second row on a desktop when a section had more tabs than fit
 * beside the search box (Accounting).
 *
 * Two things keep every tab reachable on that one row:
 *  - When the strip does not fit beside the breadcrumb, search and icons, it takes its own full-width line in the top bar
 *    (`tms-topbar-tabs-own-row`), so a typical desktop shows every tab.
 *  - When it still does not fit (narrow window, iPad, phone), the row scrolls sideways inside itself, with a fade on whichever edge
 *    has more tabs past it (`data-fade-start` / `data-fade-end` on the strip).
 */

export const OWN_ROW_CLASS = 'tms-topbar-tabs-own-row'

/** Does a strip needing `needed` px fit beside the rest of the top bar's row? */
export function tabsNeedOwnRow(p: { needed: number; rowWidth: number; othersWidth: number; gaps: number }): boolean {
  return p.needed > p.rowWidth - p.othersWidth - p.gaps
}

/** Which edges of a scrolling strip hide tabs (1px of slack for sub-pixel scroll positions). */
export function fadeEdges(p: { scrollLeft: number; scrollWidth: number; clientWidth: number }): { start: boolean; end: boolean } {
  if (p.scrollWidth <= p.clientWidth + 1) return { start: false, end: false }
  return { start: p.scrollLeft > 1, end: p.scrollLeft + p.clientWidth < p.scrollWidth - 1 }
}

const px = (v: string): number => Number.parseFloat(v) || 0

/** Keeps the top bar's tab strip on one row and its edge fades current. Returns the cleanup. */
export function watchOneRowTabs(topbar: HTMLElement): () => void {
  const nav = topbar.querySelector<HTMLElement>('.tms-lifecycle')
  const list = nav?.querySelector<HTMLElement>('.tms-lifecycle-list')
  if (!nav || !list) return () => undefined

  const updateFades = (): void => {
    const edges = fadeEdges(list)
    nav.toggleAttribute('data-fade-start', edges.start)
    nav.toggleAttribute('data-fade-end', edges.end)
  }

  const layout = (): void => {
    const style = getComputedStyle(topbar)
    // Measured as laid out now: inline, the search box has given way; on its own row it is full width. That difference is the
    // hysteresis that stops the strip flipping between the two on every resize. (Phones and iPads get the own line from
    // responsive.css as well; the class changes nothing there.)
    const others = Array.from(topbar.children).filter((el) => el !== nav && !el.classList.contains('tms-topbar-spacer')) as HTMLElement[]
    const othersWidth = others.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)
    const rowWidth = topbar.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
    // scrollWidth of a no-wrap list is the width every tab needs, wherever the strip sits.
    topbar.classList.toggle(OWN_ROW_CLASS, tabsNeedOwnRow({ needed: list.scrollWidth, rowWidth, othersWidth, gaps: px(style.columnGap) * others.length }))
    updateFades()
  }

  layout()
  list.addEventListener('scroll', updateFades, { passive: true })
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layout)
  ro?.observe(topbar)
  ro?.observe(list)
  return () => {
    list.removeEventListener('scroll', updateFades)
    ro?.disconnect()
    topbar.classList.remove(OWN_ROW_CLASS)
  }
}
