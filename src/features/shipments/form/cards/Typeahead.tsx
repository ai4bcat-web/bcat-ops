/**
 * The type-ahead the Customer and Location fields share: a text input and a list of buttons.
 * Controlled: the parent decides what text the input shows and which items are offered (recently
 * used first when the box is empty). Esc closes the list; focus leaving closes it.
 */
import { useState } from 'react'
import { TmsInput } from '@/features/tms/kit'

export interface TypeaheadItem {
  id: string
  label: string
  /** Muted second line (city, state). */
  sub?: string
  recent?: boolean
}

interface TypeaheadProps {
  value: string
  onValueChange: (text: string) => void
  items: TypeaheadItem[]
  onPick: (id: string) => void
  ariaLabel: string
  /** `data-testid` of the input. */
  inputTestId: string
  /** `data-testid` of every option button. */
  optionTestId?: string
  /** When set, input and list sit in a `role="group"` carrying this test id (the AH harness finds `[id] input` / `[id] li button`). */
  groupTestId?: string
  placeholder?: string
  disabled?: boolean
  title?: string
  /** Called on focus, so the parent can start a lazy directory read. */
  onFocus?: () => void
  onBlur?: () => void
  /** Last row when the typed text matches nothing: "+ Add <typed> as a new location". Enter on no match does the same. */
  addRow?: { label: string; testId: string; onAdd: () => void } | null
}

export function Typeahead({
  value, onValueChange, items, onPick, ariaLabel, inputTestId, optionTestId, groupTestId, placeholder, disabled, title, onFocus, onBlur, addRow,
}: TypeaheadProps) {
  const [open, setOpen] = useState(false)
  const input = (
    <TmsInput
      aria-label={ariaLabel} data-testid={inputTestId} autoComplete="off" placeholder={placeholder}
      value={value} disabled={disabled} title={title}
      onChange={(e) => { onValueChange(e.target.value); setOpen(true) }}
      onFocus={() => { setOpen(true); onFocus?.() }}
      onBlur={() => { setOpen(false); onBlur?.() }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) }
        if (e.key === 'Enter' && addRow && items.length === 0) { e.preventDefault(); e.stopPropagation(); setOpen(false); addRow.onAdd() }
      }}
    />
  )
  const list = open && (items.length > 0 || addRow) && (
    <ul className="ship-typeahead-list tms-card-typeahead-list" role="listbox" aria-label={`${ariaLabel} suggestions`}>
      {items.map((it) => (
        <li key={it.id} role="option" aria-selected={false}>
          <button
            type="button" data-testid={optionTestId} data-recent={it.recent ? 'true' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onPick(it.id); setOpen(false) }}
          >
            <span>{it.label}</span>
            {it.sub && <span className="tms-card-typeahead-sub">{it.sub}</span>}
          </button>
        </li>
      ))}
      {addRow ? (
        <li role="option" aria-selected={false}>
          <button type="button" className="tms-card-typeahead-add" data-testid={addRow.testId} onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); addRow.onAdd() }}>
            {addRow.label}
          </button>
        </li>
      ) : null}
    </ul>
  )
  const body = <>{input}{list}</>
  return groupTestId
    ? <div className="ship-typeahead" role="group" data-testid={groupTestId}>{body}</div>
    : <div className="ship-typeahead">{body}</div>
}
