/**
 * Phone form of the app's plain tables (Ryne 2026-11-14: "every page ... like the dashboard where you can see all details and numbers
 * cleanly on mobile"). DenseGrid lists already turn into cards below 640px (DenseCards); the rest of the app draws ordinary <table>s
 * (shadcn Table, TmsTable, hand-written tables on Expenses, Fuel, Insurance, Reports, settlements, settings ...). Rather than give each of
 * those pages its own phone layout, the shell labels every data cell with its column header (`data-label`) and marks the table
 * `data-phone-stack="on"`; responsive.css then draws each row as a card of label / value pairs at phone width. Desktop never matches the
 * CSS, so nothing changes there.
 *
 * A table opts out with `data-phone-stack="off"` on itself or any ancestor (wide editors that read better scrolled). Screen-reader-only
 * tables behind charts and everything on the Operations Dashboard (`.tms-phone-keep`, already laid out for a phone and the reference
 * Ryne gave) are skipped too. Narrow tables (fewer than MIN_COLUMNS headed columns) already fit a phone and are left alone.
 */

export const MIN_COLUMNS = 4

/** Header text of each column of `table`, expanded by colSpan, from the last header row (the one over the data). */
export function columnLabels(table: HTMLTableElement): string[] {
  const rows = table.tHead?.rows
  const headRow = rows && rows.length > 0 ? rows[rows.length - 1] : null
  if (!headRow) return []
  const labels: string[] = []
  for (const cell of Array.from(headRow.cells)) {
    const text = (cell.getAttribute('aria-label') || cell.textContent || '').replace(/\s+/g, ' ').trim()
    const span = Math.max(1, cell.colSpan || 1)
    for (let i = 0; i < span; i++) labels.push(text)
  }
  return labels
}

function optedOut(table: HTMLTableElement): boolean {
  if (table.classList.contains('tms-dg-table') || table.classList.contains('sr-only') || table.classList.contains('tms-sr-only')) return true
  return table.closest('[data-phone-stack="off"], .tms-phone-keep') !== null
}

/** Label one table's body and foot cells; returns whether it was marked for stacking. */
export function labelTable(table: HTMLTableElement): boolean {
  if (optedOut(table)) return false
  const labels = columnLabels(table)
  if (labels.filter(Boolean).length < MIN_COLUMNS) {
    if (table.dataset.phoneStack === 'on') delete table.dataset.phoneStack
    return false
  }
  const sections = [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])]
  for (const section of sections) {
    for (const row of Array.from(section.rows)) {
      let col = 0
      for (const cell of Array.from(row.cells)) {
        const label = labels[col] ?? ''
        if (cell.dataset.label !== label) {
          if (label) cell.dataset.label = label
          else delete cell.dataset.label
        }
        col += Math.max(1, cell.colSpan || 1)
      }
    }
  }
  if (table.dataset.phoneStack !== 'on') table.dataset.phoneStack = 'on'
  return true
}

/**
 * Tag the older shadcn dialogs and side sheets (not tms-dialog-content) so responsive.css can make them phone sheets. Only runs while the
 * app shell is mounted, so the driver app's dialogs never change.
 */
export function markPhoneSheets(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.tms-portal[role="dialog"]:not(.tms-dialog-content)'))) {
    const kind = el.classList.contains('h-full') ? 'side' : 'dialog'
    if (el.dataset.phoneSheet !== kind) el.dataset.phoneSheet = kind
  }
}

/** Label every plain table under `root`. */
export function labelTables(root: ParentNode): number {
  let marked = 0
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (labelTable(table)) marked += 1
  }
  return marked
}

/**
 * While the screen is phone-width, keep every plain table on the page (dialogs included: they portal to <body>) labelled as rows are
 * added. Watches child-list changes only, so the labels it writes never wake it again.
 */
export function watchPhoneTables(root: HTMLElement): () => void {
  let frame = 0
  const run = () => {
    frame = 0
    labelTables(root)
    markPhoneSheets(root)
  }
  const schedule = () => {
    if (frame) return
    frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number)
  }
  run()
  const observer = new MutationObserver(schedule)
  observer.observe(root, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  }
}
