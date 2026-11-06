/**
 * Card 5: Carrier & Tracking (Step AR, feedback 9). One card, top to bottom:
 *  1. the carrier block (CarrierCard: lookup, Cover / Assign, details, drivers, Ivan Cartage roster picker);
 *  2. the TrackingModeControl, where a person chooses and confirms how THIS load is tracked (the
 *     customer's default is only a suggestion). Read-only until a carrier is booked;
 *  3. the high-level tracking read (status, method, assignee, last position, ETA, check calls, POD,
 *     Open in Load Tracking). Before a carrier is booked it says "Tracking is chosen when the
 *     carrier is booked" with the customer's suggestion greyed.
 * The amber "Tracking mode not set" chip shows in the card when a carrier is booked and nothing is confirmed.
 */
import { memo, useCallback } from 'react'
import { activeLoadCarrier } from '../model'
import { TrackingModeControl } from '../../trackingModeControl/TrackingModeControl'
import { TrackingModeNotSetChip } from '../../trackingModeControl/TrackingModeNotSetChip'
import type { CardProps } from './cardRegistry'
import { CarrierCard } from './CarrierCard'
import { TrackingPlanned, TrackingReadout } from './TrackingCard'

function CarrierTrackingCardImpl(props: CardProps) {
  const { ctx } = props
  const bundle = ctx.mode === 'edit' ? ctx.bundle : null
  const booked = bundle !== null && activeLoadCarrier(bundle) !== null
  const onSaved = useCallback(() => ctx.refreshBundle(), [ctx])
  return (
    <div className="tms-card-body-stack" data-testid="section-carrier-tracking">
      <CarrierCard {...props} />
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
            {booked ? <TrackingReadout {...props} bundle={bundle} /> : <p className="tms-muted text-sm" data-testid="card-tracking-after-create">Tracking is chosen when the carrier is booked.</p>}
          </>
        ) : <TrackingPlanned {...props} />}
      </div>
    </div>
  )
}

export const CarrierTrackingCard = memo(CarrierTrackingCardImpl)
