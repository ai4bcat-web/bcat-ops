/**
 * The select-all tick in a table header: ticks every row the table shows right now (after
 * search and filters) that can be ticked, and clears them again. It is indeterminate when only
 * some are ticked. It changes ticks only: nothing is generated, factored or sent from here.
 */
export function SelectAllBox({ ids, selected, onSelect, noun }: {
  /** The ids of the shown rows that can be ticked. */
  ids: string[]
  selected: string[]
  onSelect: (next: string[]) => void
  /** Plural, for the label: "invoices", "shipments". */
  noun: string
}) {
  if (ids.length === 0) return null
  const on = ids.filter((id) => selected.includes(id)).length
  const all = on === ids.length
  return (
    <input
      type="checkbox"
      data-testid="ar-select-all"
      aria-label={`Select all ${ids.length} ${noun} shown`}
      title={all ? `Clear ${ids.length} selected` : `Select all ${ids.length}`}
      checked={all}
      ref={(el) => { if (el) el.indeterminate = on > 0 && !all }}
      onClick={(event) => event.stopPropagation()}
      onChange={() => onSelect(all
        ? selected.filter((id) => !ids.includes(id))
        : [...selected, ...ids.filter((id) => !selected.includes(id))])}
    />
  )
}
