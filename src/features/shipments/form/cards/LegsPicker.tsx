/**
 * Legs (AT-plan D9): the stops one carrier covers. Empty = every stop; ticking stops narrows it.
 * The picker only edits the slot's `legStopIds`; Save changes writes them through UPDATE_LOAD_CARRIER_DETAILS
 * (booked) or ADD_CARRIER (a new carrier). `validateLegs` messages show inline and never block.
 */
import { memo } from 'react'
import { validateLegs } from '@/lib/carrierLegs'
import type { Stop } from '@/types'

export interface LegsPickerProps {
  slot: string
  /** The route's stops (any order; shown by sequence). */
  stops: readonly Stop[]
  value: string[]
  disabled: boolean
  onChange: (next: string[]) => void
  /** Every carrier's legs, so the picker can warn about a stop nobody covers. */
  allCarriers: { id: string; legStopIds: string[]; carrierName?: string }[]
}

const stopLabel = (s: Stop, i: number, last: number): string => {
  const kind = i === 0 ? 'Pick up' : i === last ? 'Delivery' : 'Stop'
  const place = s.city || s.name || ''
  return `${i + 1}. ${kind}${place ? ` · ${place}` : ''}`
}

function LegsPickerImpl({ slot, stops, value, disabled, onChange, allCarriers }: LegsPickerProps) {
  const ordered = stops.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const all = value.length === 0
  const check = validateLegs(allCarriers, ordered)
  const messages = [...check.errors, ...check.warnings]
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    // Ticking every stop is the same as "All stops".
    onChange(next.length === ordered.length ? [] : ordered.filter((s) => next.includes(s.id)).map((s) => s.id))
  }
  return (
    <fieldset className="tms-legs" data-testid={`carrier-legs-${slot}`} disabled={disabled}>
      <legend className="tms-card-cap">Legs</legend>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" data-testid={`carrier-legs-all-${slot}`} checked={all} onChange={() => onChange([])} />
          All stops
        </label>
        {ordered.map((s, i) => (
          <label key={s.id} className="flex items-center gap-1">
            <input
              type="checkbox" data-testid={`carrier-leg-${slot}-${s.id}`}
              checked={all || value.includes(s.id)}
              onChange={() => (all ? onChange(ordered.filter((o) => o.id !== s.id).map((o) => o.id)) : toggle(s.id))}
            />
            {stopLabel(s, i, ordered.length - 1)}
          </label>
        ))}
      </div>
      {messages.map((m) => <p key={m} className="tms-muted text-xs" data-testid={`carrier-legs-note-${slot}`}>{m}</p>)}
    </fieldset>
  )
}

export const LegsPicker = memo(LegsPickerImpl)
