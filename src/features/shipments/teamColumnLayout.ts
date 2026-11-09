/**
 * The Shipments list has ONE column layout for everybody: the team default. It lives in a
 * ShipmentColumnTemplate row with a reserved id, written only by tms-directory-actions
 * (SAVE_COLUMN_TEMPLATE refuses a non-admin for this id) and read by everyone. There are no
 * personal layouts: whatever a browser kept in localStorage for columns/widths/pins is ignored.
 */
import type { ShipmentColumnTemplateRecord } from '@/types/tms'

/** Keep in step with TEAM_DEFAULT_COLUMN_TEMPLATE_ID in tms-directory-actions/handler.ts. */
export const TEAM_DEFAULT_COLUMN_TEMPLATE_ID = 'shipments-team-default'
export const TEAM_DEFAULT_COLUMN_TEMPLATE_NAME = 'Shipments team default'

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
export function resolveTeamLayout(
  templates: readonly Pick<ShipmentColumnTemplateRecord, 'id' | 'columns' | 'widths' | 'pinned'>[],
  validKeys: readonly string[],
  defaultColumns: readonly string[],
): TeamColumnLayout {
  const fallback: TeamColumnLayout = { columns: [...defaultColumns], widths: {}, pinned: [] }
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
  const pinned = Array.isArray(saved.pinned) ? saved.pinned.filter((k) => columns.includes(k)) : []
  return { columns, widths, pinned }
}
