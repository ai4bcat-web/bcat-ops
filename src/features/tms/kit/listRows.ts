import type { TmsBreakdownRow } from './TmsBreakdownCard'
import type { TmsListRow } from './TmsListCard'

/** Breakdown rows as list rows; each selectable row toggles `selected` through `onSelect`. */
export function breakdownListRows(rows: TmsBreakdownRow[], selected: string | null, onSelect: (key: string | null) => void): TmsListRow[] {
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    share: row.share,
    kind: row.kind,
    title: row.title,
    ...(row.readOnly ? {} : { active: selected === row.key, onClick: () => onSelect(selected === row.key ? null : row.key) }),
  }))
}
