/**
 * Card 5: Carrier & Tracking (Step AR feedback 9; several carriers per shipment, AT-plan section 6). Top to bottom:
 *  1. one block per carrier of the load (`values.carriers`): the carrier section (lookup, Cover / Assign, details,
 *     drivers, Send Rate Conf / Dispatch / Info for THAT carrier), the Legs picker and the per-carrier tracking
 *     override when there is more than one carrier, and Remove. A single carrier renders exactly the one block
 *     it always did, with no chrome; "+ Add carrier" shows once the first carrier is booked;
 *  2. the shipment's TrackingModeControl (the customer's default is only a suggestion). Read-only until a
 *     carrier is booked;
 *  3. the high-level tracking read (status, method, assignee, last position, ETA, check calls, POD,
 *     Open in Load Tracking). Before a carrier is booked it says "Tracking is chosen when the
 *     carrier is booked" with the customer's suggestion greyed.
 * The amber "Tracking mode not set" chip shows in the card when a carrier is booked and nothing is confirmed.
 */
import { memo, useCallback, useState } from 'react'
import { toast } from 'sonner'
import { RemoveCarrierDialog } from '@/features/shipments/components/StatusActions'
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { removeLoadCarrier } from '@/lib/apiClient'
import { carrierPhase, validateCarrierAdd, type CarrierPhase } from '@/lib/carrierLegs'
import type { LoadCarrierRecord } from '@/types/tms'
import {
  MAX_CARRIER_SLOTS, activeLoadCarrier, blockOf, carrierSlotsOf, emptyCarrierSlot, liveCarriers, nextSlotKey,
  type CarrierSlot,
} from '../model'
import { CarrierInformationSection } from '../sections/CarrierInformationSection'
import { CarrierTrackingOverride } from '../../trackingModeControl/CarrierTrackingOverride'
import { TrackingModeControl } from '../../trackingModeControl/TrackingModeControl'
import { TrackingModeNotSetChip } from '../../trackingModeControl/TrackingModeNotSetChip'
import type { CardProps } from './cardRegistry'
import { CarrierCard } from './CarrierCard'
import { LegsPicker } from './LegsPicker'
import { carrierLabel } from './ratesSummary'
import { TrackingPlanned, TrackingReadout } from './TrackingCard'

const PHASE_TEXT: Record<CarrierPhase, string> = {
  NOT_STARTED: 'Not started', AT_PICKUP: 'At pickup', IN_TRANSIT: 'In transit', AT_DELIVERY: 'At delivery', DONE: 'Done',
}

/** The assignment a slot shows: by its booked id; slot 0 falls back to the primary one. */
function loadCarrierOf(live: readonly LoadCarrierRecord[], slot: CarrierSlot, index: number): LoadCarrierRecord | null {
  return live.find((lc) => lc.id === slot.loadCarrierId) ?? (index === 0 ? live[0] ?? null : null)
}

function CarrierTrackingCardImpl(props: CardProps) {
  const { ctx, values, update } = props
  const bundle = ctx.mode === 'edit' ? ctx.bundle : null
  const booked = bundle !== null && activeLoadCarrier(bundle) !== null
  const onSaved = useCallback(() => ctx.refreshBundle(), [ctx])
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  const slots = carrierSlotsOf(values)
  const multi = slots.length > 1
  const live = liveCarriers(bundle)
  const stops = bundle?.loads[0]?.stops ?? []
  const off = ctx.busy || ctx.locked.voided

  const firstBooked = loadCarrierOf(live, slots[0], 0) !== null
  const addBlock = !firstBooked ? null
    : validateCarrierAdd(
      live.map((lc) => ({ id: lc.id, kind: lc.kind, carrierId: lc.carrierId, legStopIds: lc.legStopIds })),
      { kind: 'CARRIER' },
    ) ?? (slots.length >= MAX_CARRIER_SLOTS ? `A load can have at most ${MAX_CARRIER_SLOTS} carriers` : null)
      ?? (slots.some((s, i) => !loadCarrierOf(live, s, i)) ? 'Cover the carrier you just added first' : null)

  const addSlot = () => update((p) => {
    const all = carrierSlotsOf(p)
    return { ...p, carriers: [...p.carriers, emptyCarrierSlot(nextSlotKey(all))] }
  })
  const patchSlot = (key: string, patch: Partial<CarrierSlot>) =>
    update((p) => ({ ...p, carriers: p.carriers.map((s) => (s.slot === key ? { ...s, ...patch } : s)) }))
  const dropSlot = (key: string) => update((p) => ({ ...p, carriers: p.carriers.filter((s) => s.slot !== key) }))

  const removeTarget = removing ? slots.findIndex((s) => s.slot === removing) : -1
  const removeLc = removeTarget >= 0 ? loadCarrierOf(live, slots[removeTarget], removeTarget) : null
  const closeRemove = () => setRemoving(null)

  const blockName = (s: CarrierSlot, i: number) => carrierLabel(s, i, ctx.directory.carriers, true)

  const renderBlock = (s: CarrierSlot, i: number) => {
    const lc = loadCarrierOf(live, s, i)
    const legs = (
      <LegsPicker
        slot={s.slot} stops={stops} value={s.legStopIds} disabled={off}
        allCarriers={slots.map((o, j) => ({ id: o.slot, legStopIds: o.legStopIds, carrierName: blockName(o, j) }))}
        onChange={(next) => patchSlot(s.slot, { legStopIds: next })}
      />
    )
    return (
      <div key={s.slot} className="tms-carrier-block" data-testid={`carrier-block-${s.slot}`}>
        <div className="flex items-center gap-2 text-sm">
          <strong data-testid={`carrier-block-title-${s.slot}`}>{blockName(s, i)}</strong>
          {lc?.assignmentStatus ? <TmsBadge tone="gray">{lc.assignmentStatus}</TmsBadge> : null}
          {lc ? <span className="tms-muted text-xs" data-testid={`carrier-phase-${s.slot}`}>{PHASE_TEXT[carrierPhase(lc, stops)]}</span> : null}
          {(lc || i > 0) ? (
            <TmsButton
              size="sm" variant="ghost" data-testid={`carrier-remove-${s.slot}`} disabled={off}
              onClick={() => setRemoving(s.slot)}
            >
              Remove carrier
            </TmsButton>
          ) : null}
        </div>
        {i === 0 ? <CarrierCard {...props} /> : (
          <CarrierInformationSection
            value={blockOf(s)}
            onChange={(patch) => update((p) => ({
              ...p,
              carriers: p.carriers.map((o) => (o.slot === s.slot ? { ...o, ...(typeof patch === 'function' ? patch(blockOf(o)) : patch) } : o)),
            }))}
            ctx={ctx} form={props.form} expanded
            slotKey={s.slot} index={i} loadCarrier={lc} legStopIds={s.legStopIds}
          />
        )}
        {bundle && stops.length > 1 ? legs : null}
        {lc ? (
          <CarrierTrackingOverride slot={s.slot} loadCarrier={lc} disabled={off} onSaved={onSaved} />
        ) : null}
      </div>
    )
  }

  const confirmRemoveUnbooked = () => {
    if (removing) dropSlot(removing)
    closeRemove()
  }
  const confirmRemoveBooked = (reason: Parameters<typeof removeLoadCarrier>[0]['reason'], note?: string, repostToDat?: boolean) => {
    if (!removeLc) return
    const key = removing
    const wasFirst = removeTarget === 0
    setRemoveBusy(true)
    void removeLoadCarrier({ loadCarrierId: removeLc.id, outcome: 'BOUNCED', reason, note, ...(repostToDat ? { repostToDat } : {}) })
      .then(async () => {
        if (key) {
          // The first slot is the legacy-mirrored one: the next carrier moves into it.
          update((p) => ({ ...p, carriers: wasFirst ? p.carriers.slice(1) : p.carriers.filter((o) => o.slot !== key) }))
        }
        await ctx.refreshBundle()
        toast.success('Carrier removed')
      })
      .catch((err: unknown) => { toast.error(err instanceof Error ? err.message : 'The carrier was not removed') })
      .finally(() => { setRemoveBusy(false); closeRemove() })
  }

  return (
    <div className="tms-card-body-stack" data-testid="section-carrier-tracking">
      {multi ? slots.map(renderBlock) : <CarrierCard {...props} />}
      {firstBooked ? (
        <div className="flex flex-wrap items-center gap-2">
          <TmsButton size="sm" data-testid="carrier-add" title={addBlock ?? undefined} disabled={off || addBlock != null} onClick={addSlot}>
            + Add carrier
          </TmsButton>
          {addBlock ? <span className="tms-muted text-xs" data-testid="carrier-add-reason">{addBlock}</span> : null}
        </div>
      ) : null}
      <div className="tms-trk-half" data-testid="card-tracking-body">
        <div className="tms-trk-half-head">
          <span className="tms-trk-half-title">Tracking</span>
          {bundle ? <TrackingModeNotSetChip shipment={bundle.shipment} hasCarrier={booked} /> : null}
        </div>
        {bundle ? (
          <>
            <TrackingModeControl
              shipment={bundle.shipment} load={bundle.loads[0] ?? null} customer={ctx.customer} settings={ctx.settings}
              disabled={!booked || ctx.locked.voided || ctx.busy} onSaved={onSaved}
            />
            {booked ? null : <p className="tms-muted text-sm" data-testid="card-tracking-after-create">Tracking is chosen when the carrier is booked.</p>}
            <TrackingReadout {...props} bundle={bundle} />
          </>
        ) : <TrackingPlanned {...props} />}
      </div>
      {removing && removeLc ? (
        <RemoveCarrierDialog outcome="BOUNCED" loadCarrier={removeLc} busy={removeBusy} onClose={closeRemove} onConfirm={confirmRemoveBooked} />
      ) : null}
      {removing && !removeLc ? (
        <TmsDialog
          open onOpenChange={(v) => { if (!v) closeRemove() }} title="Remove carrier"
          footer={(
            <>
              <TmsButton variant="ghost" data-testid="carrier-remove-cancel" onClick={closeRemove}>Cancel</TmsButton>
              <TmsButton variant="primary" data-testid="carrier-remove-confirm" onClick={confirmRemoveUnbooked}>Remove</TmsButton>
            </>
          )}
        >
          <p className="text-sm">Remove {removeTarget >= 0 ? blockName(slots[removeTarget], removeTarget) : 'this carrier'} from the form? Nothing was booked for it.</p>
        </TmsDialog>
      ) : null}
    </div>
  )
}

export const CarrierTrackingCard = memo(CarrierTrackingCardImpl)
