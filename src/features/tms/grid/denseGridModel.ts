/**
 * The pure half of the dense grid: how a row is filtered by a column's header filter, how a
 * column sorts, which options a multi-select offers and how wide a column fits its content.
 * No React, no I/O, so the rules are testable and the Shipments lists, Load Tracking and
 * Intake all narrow and order rows the same way.
 */
import { chicagoDateStr } from '@/lib/date'

export type DenseFilterKind = 'text' | 'multi' | 'date' | 'number'
export type DenseDensity = 'compact' | 'comfortable'

export interface DenseOption {
  value: string
  label: string
}

export interface DenseSort {
  key: string
  dir: 'asc' | 'desc'
}

export interface DenseColumn<T> {
  key: string
  header: string
  /** The plain text of the cell: type-ahead filter, tooltip, auto-fit and the default sort value. */
  text: (row: T) => string
  /** Sort value; defaults to `numberOf`, then `dateOf`, then `text`. Null/'' always sort last. */
  sortValue?: (row: T) => string | number | null
  /** False removes the click-to-sort header. */
  sortable?: boolean
  /** The header filter; defaults to the text type-ahead. `false` removes the filter. */
  filter?: DenseFilterKind | false
  /** `multi`: the facet value(s) a row has. Defaults to the row's text as the one value. */
  optionsOf?: (row: T) => DenseOption[]
  /** `multi`: a fixed option list (e.g. every status), counts still come from the rows. */
  fixedOptions?: DenseOption[]
  /** `date`: an ISO timestamp or yyyy-mm-dd; compared by America/Chicago calendar day. */
  dateOf?: (row: T) => string | null
  /** `number`: the numeric value the min/max range compares. */
  numberOf?: (row: T) => number | null
  /** Unit shown beside the number range inputs. */
  numberUnit?: string
  /** Width floor / ceiling in px for resize and auto-fit. */
  minWidth?: number
  maxWidth?: number
  /** A fixed pixel width instead of auto-fit (icon and action columns). */
  width?: number
  /** A fixed column cannot be reordered, resized or hidden from the chooser. */
  fixed?: boolean
  align?: 'left' | 'right'
}

export interface DenseColumnFilter {
  text?: string
  values?: string[]
  exclude?: boolean
  /** Inclusive yyyy-mm-dd; either end may be open. */
  from?: string
  to?: string
  min?: number
  max?: number
}

export type DenseFilters = Record<string, DenseColumnFilter>

export function filterKindOf<T>(col: DenseColumn<T>): DenseFilterKind | null {
  if (col.filter === false) return null
  return col.filter ?? 'text'
}

export function isFilterActive(f: DenseColumnFilter | undefined): boolean {
  if (!f) return false
  return Boolean(
    (f.text && f.text.trim()) || (f.values && f.values.length > 0) || f.from || f.to || f.min != null || f.max != null,
  )
}

export function activeFilterCount(filters: DenseFilters): number {
  return Object.values(filters).filter(isFilterActive).length
}

/** The facet options a row carries in a `multi` column. */
export function optionsOfRow<T>(col: DenseColumn<T>, row: T): DenseOption[] {
  if (col.optionsOf) return col.optionsOf(row)
  const text = col.text(row)
  return text ? [{ value: text, label: text }] : []
}

function dayOf(value: string | null): string | null {
  if (!value) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : chicagoDateStr(value)
}

export function matchesColumnFilter<T>(row: T, col: DenseColumn<T>, f: DenseColumnFilter): boolean {
  const kind = filterKindOf(col)
  if (!kind || !isFilterActive(f)) return true
  switch (kind) {
    case 'text': {
      const needle = (f.text ?? '').trim().toLowerCase()
      return needle === '' || col.text(row).toLowerCase().includes(needle)
    }
    case 'multi': {
      if (!f.values || f.values.length === 0) return true
      const values = optionsOfRow(col, row).map((o) => o.value)
      const hit = values.some((v) => f.values!.includes(v))
      // An exclusion keeps a row that has no value for the facet; an inclusion drops it.
      if (f.exclude) return values.length === 0 || !hit
      return hit
    }
    case 'date': {
      if (!f.from && !f.to) return true
      const day = dayOf(col.dateOf ? col.dateOf(row) : null)
      if (!day) return false
      return (!f.from || day >= f.from) && (!f.to || day <= f.to)
    }
    case 'number': {
      if (f.min == null && f.max == null) return true
      const n = col.numberOf ? col.numberOf(row) : null
      if (n == null || Number.isNaN(n)) return false
      return (f.min == null || n >= f.min) && (f.max == null || n <= f.max)
    }
  }
}

/** Rows that satisfy every active header filter. Returns the input when nothing is active. */
export function filterRows<T>(rows: readonly T[], columns: readonly DenseColumn<T>[], filters: DenseFilters): T[] {
  const active = columns.filter((c) => isFilterActive(filters[c.key]))
  if (active.length === 0) return rows as T[]
  return rows.filter((row) => active.every((col) => matchesColumnFilter(row, col, filters[col.key])))
}

function sortValueOf<T>(col: DenseColumn<T>, row: T): string | number | null {
  if (col.sortValue) return col.sortValue(row)
  if (col.numberOf) return col.numberOf(row)
  if (col.dateOf) return col.dateOf(row)
  return col.text(row)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Stable sort by one column; missing values sort last in either direction. */
export function sortDenseRows<T>(rows: readonly T[], columns: readonly DenseColumn<T>[], sort: DenseSort | null): T[] {
  const col = sort ? columns.find((c) => c.key === sort.key) : undefined
  if (!sort || !col) return rows as T[]
  const dir = sort.dir === 'asc' ? 1 : -1
  const keyed = rows.map((row, index) => ({ row, index, value: sortValueOf(col, row) }))
  keyed.sort((a, b) => {
    const am = a.value == null || a.value === ''
    const bm = b.value == null || b.value === ''
    if (am || bm) return am && bm ? a.index - b.index : am ? 1 : -1
    let cmp: number
    if (typeof a.value === 'number' && typeof b.value === 'number') cmp = a.value - b.value
    else cmp = collator.compare(String(a.value), String(b.value))
    return cmp !== 0 ? cmp * dir : a.index - b.index
  })
  return keyed.map((k) => k.row)
}

/** asc → desc → unsorted, then the next column starts at asc. */
export function nextSort(prev: DenseSort | null, key: string): DenseSort | null {
  if (!prev || prev.key !== key) return { key, dir: 'asc' }
  return prev.dir === 'asc' ? { key, dir: 'desc' } : null
}

export interface DenseFacet extends DenseOption {
  count: number
}

/** The options a multi-select offers: fixed ones first-class, plus every value the rows carry. */
export function facetOptions<T>(rows: readonly T[], col: DenseColumn<T>): DenseFacet[] {
  const map = new Map<string, DenseFacet>()
  for (const o of col.fixedOptions ?? []) map.set(o.value, { ...o, count: 0 })
  for (const row of rows) {
    for (const o of optionsOfRow(col, row)) {
      const entry = map.get(o.value)
      if (entry) entry.count += 1
      else map.set(o.value, { value: o.value, label: o.label, count: 1 })
    }
  }
  const all = [...map.values()]
  return col.fixedOptions ? all : all.sort((a, b) => collator.compare(a.label, b.label))
}

const CHAR_PX = 6.6
const CELL_PAD_PX = 20
const HEADER_CHROME_PX = 44
const AUTO_FIT_SAMPLE = 200
export const DEFAULT_MIN_WIDTH = 56
export const DEFAULT_MAX_WIDTH = 340
export const CHECK_COLUMN_WIDTH = 30
/** Fixed row heights (px): the list is virtualised on them, and the CSS reads the same number. */
export const ROW_HEIGHT: Record<DenseDensity, number> = { compact: 30, comfortable: 40 }

export function clampWidth<T>(col: DenseColumn<T>, px: number): number {
  return Math.round(Math.min(col.maxWidth ?? DEFAULT_MAX_WIDTH, Math.max(col.minWidth ?? DEFAULT_MIN_WIDTH, px)))
}

/**
 * Width that fits the header and the longest of the first rows' text, between the column's
 * min and max. A text estimate (not a DOM measure) so a virtualised list never depends on
 * which rows happen to be mounted.
 */
export function autoColumnWidth<T>(col: DenseColumn<T>, rows: readonly T[]): number {
  if (col.width != null) return col.width
  let longest = 0
  const n = Math.min(rows.length, AUTO_FIT_SAMPLE)
  for (let i = 0; i < n; i += 1) longest = Math.max(longest, col.text(rows[i]).length)
  const content = longest * CHAR_PX + CELL_PAD_PX
  const header = col.header.length * (CHAR_PX + 0.6) + HEADER_CHROME_PX
  return clampWidth(col, Math.max(content, header))
}

/** Effective pixel width per column: the user's width, else the auto-fit one. */
export function columnWidths<T>(
  columns: readonly DenseColumn<T>[],
  rows: readonly T[],
  userWidths: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const col of columns) {
    const user = userWidths[col.key]
    out[col.key] = col.width != null ? col.width : user != null ? clampWidth(col, user) : autoColumnWidth(col, rows)
  }
  return out
}

export interface VirtualWindow {
  start: number
  end: number
  /** Pixel height of the spacer above / below the mounted rows. */
  padTop: number
  padBottom: number
}

/** Which of `count` equal-height items to mount for the scroll position, plus overscan. */
export function virtualWindow(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan: number): VirtualWindow {
  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)
  const start = Math.min(first, Math.max(0, count - 1))
  const end = Math.max(start + 1, last)
  return { start, end, padTop: start * rowHeight, padBottom: Math.max(0, (count - end) * rowHeight) }
}

/** Move `from` to the slot `to` currently occupies. */
export function reorderKeys(keys: readonly string[], from: string, to: string): string[] {
  const fromIndex = keys.indexOf(from)
  const toIndex = keys.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [...keys]
  const next = [...keys]
  next.splice(fromIndex, 1)
  next.splice(toIndex, 0, from)
  return next
}

export interface DenseGroup {
  key: string
  label: string
  /** Rows in the group before paging. */
  count: number
}

/**
 * Stable-partition rows (already sorted) into groups: `firstKey` first when present, then the
 * rest A to Z by label. Rows keep their sorted order inside each group.
 */
export function orderByGroup<T>(
  rows: readonly T[],
  describe: (row: T) => { key: string; label: string },
  firstKey?: string,
): { rows: T[]; groups: DenseGroup[] } {
  const byKey = new Map<string, { group: DenseGroup; rows: T[] }>()
  for (const row of rows) {
    const { key, label } = describe(row)
    const entry = byKey.get(key)
    if (entry) {
      entry.group.count += 1
      entry.rows.push(row)
    } else {
      byKey.set(key, { group: { key, label, count: 1 }, rows: [row] })
    }
  }
  const entries = [...byKey.values()].sort((a, b) => {
    if (a.group.key === firstKey) return -1
    if (b.group.key === firstKey) return 1
    return collator.compare(a.group.label, b.group.label) || a.group.key.localeCompare(b.group.key)
  })
  return { rows: entries.flatMap((e) => e.rows), groups: entries.map((e) => e.group) }
}
