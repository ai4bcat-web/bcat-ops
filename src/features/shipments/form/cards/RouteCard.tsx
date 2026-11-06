/**
 * Card 4: Route (Step AR). A lane header (origin → destination, Customer Miles / Truck Miles with
 * the AH auto-calc and click-to-type override, transit estimate), then the stops as a vertical
 * timeline: one StopCard per stop, "+ Add pickup / + Add delivery" in the gaps, drag (or arrow
 * keys on the handle) to reorder, delete with undo. It edits the same `values.stops` rows as the
 * AH Pick Up / Consignee / Picks & Stops sections; the route must start at a pickup and end at a
 * delivery (those are the Pick Up and Consignee roles in the mapping).
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { TmsButton, TmsInput } from '@/features/tms/kit'
import { LABEL } from '../labels'
import { emptyStop, type FormStop } from '../model'
import { ctl, digitsOnly, disabledState, issueFor } from '../sections/fieldUtil'
import { FieldGrid } from '../fieldGrid'
import { LField } from '../sections/formControls'
import { routeSignature } from '../sections/milesEstimate'
import { type CardProps, sliceOf, stopsOf } from './cardRegistry'
import { canInsert, laneLabel, moveStop, removeStop, stopPrefix, transitEstimate, validOrder } from './routeUtil'
import { StopCard } from './StopCard'
import { useAutoMiles } from './useAutoMiles'
import './cards.css'

const UNDO_MS = 10_000

interface Removed { stop: FormStop; index: number }

export function RouteCard({ values, update, ctx }: CardProps) {
  const stops = values.stops
  const ship = values.ship
  const onStops = useMemo(() => stopsOf(update), [update])
  const onShip = useMemo(() => sliceOf(update, 'ship'), [update])
  const base = disabledState(ctx)
  const milesLock = disabledState(ctx, 'customerMiles')
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [removed, setRemoved] = useState<Removed | null>(null)
  const undoTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => clearTimeout(undoTimer.current), [])

  const auto = useAutoMiles(routeSignature(stops), ship.disableMileage || milesLock.disabled, onShip)
  const lane = laneLabel(stops)
  const transit = transitEstimate(ship.customerMiles)
  const isEstimate = (value: string) => auto.source === 'estimate' && value !== '' && value === auto.miles
  const customerEst = isEstimate(ship.customerMiles)
  const truckEst = isEstimate(ship.truckMiles)

  const patchStop = (i: number) => (patch: Partial<FormStop> | ((prev: FormStop) => FormStop)) =>
    onStops((prev) => prev.map((s, n) => (n === i ? (typeof patch === 'function' ? patch(s) : { ...s, ...patch }) : s)))

  const insertAt = (at: number, type: FormStop['type']) => {
    const stop = emptyStop(type)
    onStops((prev) => (canInsert(prev, at, type) ? [...prev.slice(0, at), stop, ...prev.slice(at)] : prev))
  }
  const move = (from: number, to: number) => onStops((prev) => moveStop(prev, from, to))

  const remove = (i: number) => {
    const stop = stops[i]
    onStops((prev) => removeStop(prev, i))
    setRemoved({ stop, index: i })
    clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => setRemoved(null), UNDO_MS)
  }
  const undo = () => {
    if (!removed) return
    const { stop, index } = removed
    onStops((prev) => (prev.some((s) => s.id === stop.id) ? prev : [...prev.slice(0, Math.min(index, prev.length)), stop, ...prev.slice(Math.min(index, prev.length))]))
    setRemoved(null)
    clearTimeout(undoTimer.current)
  }
  const removeBlock = (i: number): string | undefined => {
    const fixed = ctx.locked.stops[stops[i].id]
    if (fixed) return fixed
    return validOrder(stops.filter((_, n) => n !== i)) ? undefined : 'A route needs a pickup first and a delivery last'
  }

  const gap = (at: number) => (
    <li className="tms-card-gap" key={`gap-${at}`} aria-label="Add a stop here">
      <TmsButton
        type="button" size="sm" data-testid={`f-route-addPickup-${at}`} aria-label={`${LABEL.picks.insertPick.text} (position ${at + 1})`}
        disabled={base.disabled || !canInsert(stops, at, 'pickup')} onClick={() => insertAt(at, 'pickup')}
      >
        <Plus size={12} /> Add pickup
      </TmsButton>
      <TmsButton
        type="button" size="sm" data-testid={`f-route-addDelivery-${at}`} aria-label={`${LABEL.picks.insertStop.text} (position ${at + 1})`}
        disabled={base.disabled || !canInsert(stops, at, 'delivery')} onClick={() => insertAt(at, 'delivery')}
      >
        <Plus size={12} /> Add delivery
      </TmsButton>
    </li>
  )

  const milesInput = (def: typeof LABEL.shipping.customerMiles, value: string, disabled: boolean, title: string | undefined, key: 'customerMiles' | 'truckMiles', est: boolean) => (
    <LField span={6} def={def} error={issueFor(ctx, 'shipping', def.testId)} hint={est ? <span data-testid={`${def.testId}-est`}>est.</span> : undefined} className="tms-card-miles">
      <TmsInput {...ctl(def)} inputMode="numeric" value={value} disabled={disabled} title={title} onChange={(e) => onShip({ [key]: digitsOnly(e.target.value) })} />
    </LField>
  )

  return (
    <div className="tms-card-body-stack" data-testid="section-route-body">
      <div className="tms-card-lane" data-testid="f-route-laneHeader">
        <div className="tms-card-lane-main">
          <span className="tms-card-lane-label" data-testid="f-route-lane">{lane || 'Add a pickup and a delivery'}</span>
          {transit && <span className="ship-hint" data-testid="f-route-transit">≈ {transit} transit</span>}
          {auto.failed && !ship.disableMileage && <span className="ship-hint" data-testid="f-shipping-milesSource">Could not measure the route — type the miles</span>}
          {!auto.failed && auto.source === 'google' && !ship.disableMileage && <span className="ship-hint" data-testid="f-shipping-milesSource">Miles from the stop addresses</span>}
        </div>
        <FieldGrid className="tms-card-lane-miles">
          {milesInput(LABEL.shipping.customerMiles, ship.customerMiles, milesLock.disabled, milesLock.title, 'customerMiles', customerEst)}
          {milesInput(LABEL.shipping.truckMiles, ship.truckMiles, base.disabled, undefined, 'truckMiles', truckEst)}
        </FieldGrid>
      </div>

      <ol className="tms-card-timeline" aria-label="Stops">
        {stops.map((s, i) => (
          <Fragment key={s.id}>
          <li className="tms-card-timeline-item" data-dragging={dragFrom === i || undefined}
            onDragOver={(e) => { if (dragFrom !== null) e.preventDefault() }}
            onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); setDragFrom(null) }}
          >
            <StopCard
              stop={s} index={i} count={stops.length} prefix={stopPrefix(i, stops.length)}
              onChange={patchStop(i)} ctx={ctx}
              onRemove={removeBlock(i) === undefined ? () => remove(i) : null} removeBlocked={removeBlock(i)}
              onMove={(by) => move(i, i + by)}
              dragProps={{
                onDragStart: (e) => { setDragFrom(i); e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move' },
                onDragEnd: () => setDragFrom(null),
              }}
            />
          </li>
          {gap(i + 1)}
          </Fragment>
        ))}
      </ol>
      {removed && (
        <div className="tms-card-undo" role="status" data-testid="f-route-undo">
          Stop removed
          <button type="button" className="ship-link" data-testid="f-route-undoButton" onClick={undo}>Undo</button>
        </div>
      )}
    </div>
  )
}
