/**
 * The Shipments lists (Active, All, Voided) each have one column layout for everybody: the team
 * default for that list. Each lives in a ShipmentColumnTemplate row with a reserved id, written only
 * by tms-directory-actions (SAVE_COLUMN_TEMPLATE refuses a non-admin for these ids) and read by
 * everyone. There are no personal layouts: whatever a browser kept in localStorage for
 * columns/widths/pins is ignored.
 */
import type { ShipmentColumnTemplateRecord } from '@/types/tms'
import type { ShipmentList } from '@/lib/shipmentLists'

/** The All list's row (the original single team default). Keep in step with TEAM_DEFAULT_COLUMN_TEMPLATE_IDS in tms-directory-actions/handler.ts. */
export const TEAM_DEFAULT_COLUMN_TEMPLATE_ID = 'shipments-team-default'
export const TEAM_DEFAULT_COLUMN_TEMPLATE_NAME = 'Shipments team default'

const LIST_LABEL: Record<ShipmentList, string> = { active: 'Active', all: 'All', voided: 'Voided' }

export function listLabel(list: ShipmentList): string {
  return LIST_LABEL[list]
}

/** The reserved template id holding `list`'s team layout. All keeps the original id so its saved row carries over. */
export function teamTemplateIdFor(list: ShipmentList): string {
  return list === 'all' ? TEAM_DEFAULT_COLUMN_TEMPLATE_ID : `${TEAM_DEFAULT_COLUMN_TEMPLATE_ID}-${list}`
}

export function teamTemplateNameFor(list: ShipmentList): string {
  return list === 'all' ? TEAM_DEFAULT_COLUMN_TEMPLATE_NAME : `${TEAM_DEFAULT_COLUMN_TEMPLATE_NAME} (${LIST_LABEL[list]})`
}

/**
 * Columns a list leaves out of the layout it inherits from All until an admin saves that list's own
 * layout. Active hides Invoice Status (Ryne 2026-11-14: All shows it, Active does not); nothing is
 * released on Active, so the column would read Not invoiced on every row.
 */
export const LIST_HIDDEN_BY_DEFAULT: Record<ShipmentList, readonly string[]> = {
  active: ['invoiceStatus'],
  all: [],
  voided: [],
}

export interface TeamColumnLayout {
  columns: string[]
  widths: Record<string, number>
  pinned: string[]
}

/**
 * The layout everybody sees. Saved columns the board no longer knows are dropped (a retired
 * column must not blank the grid); duplicates collapse; widths and pins that point at a column
 * that is not shown are dropped. No usable saved row means the built-in default columns.
 */
/**
 * A column added to the built-in default after team layouts were already saved. A layout saved before
 * `since` never had the chance to show or hide it, so it gets the column right after `after` (when it shows `after`) (pinned with it
 * when `after` is pinned, so the two stay side by side). A layout saved on or after `since` is the admin's
 * choice and is left alone: removing the column there keeps it hidden.
 */
export interface IntroducedColumn {
  key: string
  after: string
  /** ISO time the column shipped. */
  since: string
}

export function resolveTeamLayout(
  templates: readonly (Pick<ShipmentColumnTemplateRecord, 'id' | 'columns' | 'widths' | 'pinned'> & { updatedAt?: string | null })[],
  validKeys: readonly string[],
  defaultColumns: readonly string[],
  defaultPinned: readonly string[] = [],
  introduced: readonly IntroducedColumn[] = [],
): TeamColumnLayout {
  const fallback: TeamColumnLayout = { columns: [...defaultColumns], widths: {}, pinned: defaultColumns.filter((k) => defaultPinned.includes(k)) }
  const saved = templates.find((t) => t.id === TEAM_DEFAULT_COLUMN_TEMPLATE_ID)
  if (!saved || !Array.isArray(saved.columns)) return fallback

  const valid = new Set(validKeys)
  const columns: string[] = []
  for (const key of saved.columns) {
    if (typeof key === 'string' && valid.has(key) && !columns.includes(key)) columns.push(key)
  }
  if (columns.length === 0) return fallback

  const widths: Record<string, number> = {}
  if (saved.widths && typeof saved.widths === 'object') {
    for (const [key, px] of Object.entries(saved.widths)) {
      if (columns.includes(key) && typeof px === 'number' && Number.isFinite(px) && px > 0) widths[key] = px
    }
  }
  // The frozen columns are data now: whatever the admin pinned in Edit layout. A layout saved before pins were editable has none, so it starts
  // from the built-in frozen set (only the ones it shows) until somebody pins differently and saves.
  const savedPins = Array.isArray(saved.pinned) ? saved.pinned.filter((k) => columns.includes(k)) : []
  const pinned = savedPins.length > 0 ? savedPins : columns.filter((k) => defaultPinned.includes(k))
  for (const col of introduced) {
    if (!valid.has(col.key) || columns.includes(col.key)) continue
    if (saved.updatedAt && saved.updatedAt >= col.since) continue
    const at = columns.indexOf(col.after)
    if (at < 0) continue
    columns.splice(at + 1, 0, col.key)
    const pinAt = pinned.indexOf(col.after)
    if (pinAt >= 0) pinned.splice(pinAt + 1, 0, col.key)
  }
  return { columns, widths, pinned }
}

/**
 * `list`'s layout. A list with its own saved row uses it as is. A list without one (Active and Voided,
 * until an admin first saves them) starts from the All layout, which is the one layout saved before
 * the lists split, minus the columns that list hides by default. Saving the list's own row ends the
 * inheritance once and for all, so an admin who later adds Invoice Status back to Active keeps it.
 */
export function resolveListLayout(
  list: ShipmentList,
  templates: Parameters<typeof resolveTeamLayout>[0],
  validKeys: readonly string[],
  defaultColumns: readonly string[],
  defaultPinned: readonly string[] = [],
  introduced: readonly IntroducedColumn[] = [],
): TeamColumnLayout {
  const ownId = teamTemplateIdFor(list)
  const own = templates.find((t) => t.id === ownId)
  if (list !== 'all' && own) {
    return resolveTeamLayout([{ ...own, id: TEAM_DEFAULT_COLUMN_TEMPLATE_ID }], validKeys, defaultColumns, defaultPinned, introduced)
  }
  const base = resolveTeamLayout(templates, validKeys, defaultColumns, defaultPinned, introduced)
  if (list === 'all') return base
  const hidden = new Set(LIST_HIDDEN_BY_DEFAULT[list])
  const columns = base.columns.filter((k) => !hidden.has(k))
  if (columns.length === 0) return base
  const widths = Object.fromEntries(Object.entries(base.widths).filter(([k]) => !hidden.has(k)))
  return { columns, widths, pinned: base.pinned.filter((k) => !hidden.has(k)) }
}

/** Pixels per character and the cell padding the fit adds; the clamp keeps a note column from taking the screen. */
const FIT_PX_PER_CHAR = 7.5
const FIT_PADDING_PX = 36
const FIT_MIN_PX = 60
const FIT_MAX_PX = 520

/**
 * Each column's width to fit its longest value (or its header, if that is longer): the longest text
 * among `rows`, by character count. Used by "Fit widths" while editing the team layout.
 */
export function fitColumnWidths<T>(
  columns: readonly { key: string; header: string; text?: (row: T) => string | null | undefined }[],
  rows: readonly T[],
): Record<string, number> {
  const widths: Record<string, number> = {}
  for (const col of columns) {
    let longest = col.header.length
    if (col.text) for (const row of rows) longest = Math.max(longest, String(col.text(row) ?? '').length)
    widths[col.key] = Math.min(FIT_MAX_PX, Math.max(FIT_MIN_PX, Math.round(longest * FIT_PX_PER_CHAR + FIT_PADDING_PX)))
  }
  return widths
}
