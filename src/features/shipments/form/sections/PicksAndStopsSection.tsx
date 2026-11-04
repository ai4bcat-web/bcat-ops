/**
 * Section 10: Picks & Stops. The ordered stop list as rows ("1. Pick · Name, City ST · Ref # x"),
 * Insert Pick / Insert Stop, up/down reordering and removal of inserted stops. Selecting a middle
 * row edits it in place; the first and last rows are the Pick Up and Consignee blocks above, so
 * selecting them jumps there.
 */
import { memo, useState } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { TmsButton, TmsIconButton } from '@/features/tms/kit'
import { emptyStop, type FormStop } from '../model'
import { LABEL } from '../labels'
import type { SliceSectionProps } from '../sectionRegistry'
import { StopFields } from './StopSection'
import { disabledState } from './fieldUtil'

/** Aljex's orange row: a required field of this stop is empty. */
function incomplete(s: FormStop, index: number): boolean {
  if (!s.name.trim() || !s.city.trim() || s.state.trim().length !== 2) return true
  return s.type === 'pickup' && index === 0 && !s.ready && !s.appt
}

function rowLabel(s: FormStop, index: number): string {
  const place = [s.name.trim(), [s.city.trim(), s.state.trim()].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const parts = [`${index + 1}. ${s.type === 'pickup' ? 'Pick' : 'Delivery'}`, place || '(no location yet)']
  if (s.refNo.trim()) parts.push(`Ref # ${s.refNo.trim()}`)
  return parts.join(' · ')
}

function PicksAndStopsImpl({ value: stops, onChange, ctx, form }: SliceSectionProps<'stops'>) {
  const [selected, setSelected] = useState<number | null>(null)
  const base = disabledState(ctx)
  const last = stops.length - 1

  const insertAt = (at: number, type: FormStop['type']) => {
    const stop = emptyStop(type)
    onChange((prev) => [...prev.slice(0, at), stop, ...prev.slice(at)])
    setSelected(at)
  }
  const insertPick = () => insertAt(Math.max(1, last), 'pickup')
  const insertStop = () => insertAt(selected !== null && selected < last ? selected + 1 : Math.max(1, last), 'delivery')

  const move = (i: number, by: -1 | 1) => {
    onChange((prev) => {
      const j = i + by
      if (j < 1 || j > prev.length - 2) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setSelected(i + by)
  }
  const remove = (i: number) => {
    onChange((prev) => prev.filter((_, n) => n !== i))
    setSelected(null)
  }
  const patchStop = (i: number) => (patch: Partial<FormStop> | ((prev: FormStop) => FormStop)) =>
    onChange((prev) => prev.map((s, n) => (n === i ? (typeof patch === 'function' ? patch(s) : { ...s, ...patch }) : s)))

  const select = (i: number) => {
    if (i === 0) { form.focusField('f-pickup-name', 'pickup'); return }
    if (i === last) { form.focusField('f-consignee-name', 'consignee'); return }
    setSelected(selected === i ? null : i)
  }

  return (
    <div className="ship-body" data-testid="section-picks-body">
      <div className="ship-inline">
        <TmsButton type="button" size="sm" data-testid={LABEL.picks.insertPick.testId} aria-label={LABEL.picks.insertPick.text} disabled={base.disabled} onClick={insertPick}>
          {LABEL.picks.insertPick.text}
        </TmsButton>
        <TmsButton type="button" size="sm" data-testid={LABEL.picks.insertStop.testId} aria-label={LABEL.picks.insertStop.text} disabled={base.disabled} onClick={insertStop}>
          {LABEL.picks.insertStop.text}
        </TmsButton>
      </div>
      <ol className="ship-picks-list" aria-label="Stops">
        {stops.map((s, i) => {
          const inserted = i > 0 && i < last
          const fixed = Boolean(ctx.locked.stops[s.id])
          return (
            <li key={s.id}>
              <div className="ship-pick-row" data-testid={`f-picks-row-${i}`} data-incomplete={incomplete(s, i)} data-selected={selected === i}>
                <button type="button" className="ship-pick-label" aria-expanded={inserted ? selected === i : undefined} onClick={() => select(i)}>
                  {rowLabel(s, i)}
                </button>
                <input
                  className="tms-input ship-pick-num" inputMode="numeric" placeholder={LABEL.stop.pieces.text}
                  aria-label={`${LABEL.stop.pieces.text} (stop ${i + 1})`} data-testid={`f-picks-pieces-${i}`}
                  value={s.pieces} disabled={base.disabled} onChange={(e) => patchStop(i)({ pieces: e.target.value.replace(/\D/g, '') })}
                />
                <input
                  className="tms-input ship-pick-num" inputMode="numeric" placeholder={LABEL.stop.weightLbs.text}
                  aria-label={`${LABEL.stop.weightLbs.text} (stop ${i + 1})`} data-testid={`f-picks-weight-${i}`}
                  value={s.weightLbs} disabled={base.disabled} onChange={(e) => patchStop(i)({ weightLbs: e.target.value.replace(/\D/g, '') })}
                />
                {inserted && (
                  <>
                    <TmsIconButton aria-label={`Move stop ${i + 1} up`} data-testid={`f-picks-up-${i}`} disabled={base.disabled || i <= 1} onClick={() => move(i, -1)}><ArrowUp size={13} /></TmsIconButton>
                    <TmsIconButton aria-label={`Move stop ${i + 1} down`} data-testid={`f-picks-down-${i}`} disabled={base.disabled || i >= last - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></TmsIconButton>
                    <TmsIconButton aria-label={`Remove stop ${i + 1}`} data-testid={`f-picks-remove-${i}`} title={ctx.locked.stops[s.id]} disabled={base.disabled || fixed} onClick={() => remove(i)}><Trash2 size={13} /></TmsIconButton>
                  </>
                )}
              </div>
              {inserted && selected === i && (
                <StopFields stop={s} prefix={`stop-${i}`} required={false} onChange={patchStop(i)} ctx={ctx} />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export const PicksAndStopsSection = memo(PicksAndStopsImpl)
