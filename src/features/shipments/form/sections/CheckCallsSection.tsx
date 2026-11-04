/**
 * Check Calls (Ryne, item 5): a read-only preview of the Load Tracking view for this load —
 * the one-line summary strip and the last five check calls. Logging happens in Load Tracking
 * (link below); nothing here writes.
 */
import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useDriverPhones } from '@/hooks/useTruckConfigs'
import { useLoadTracking } from '@/hooks/useLoadTracking'
import { useAppStore } from '@/store/useAppStore'
import type { ShipmentBundle } from '@/types/tms'
import { RecentCheckCalls } from '../../workstations/tracking/RecentCheckCalls'
import { TrackingSummaryStrip } from '../../workstations/tracking/TrackingSummaryStrip'
import { summaryOf } from '../../workstations/tracking/trackingSummary'
import { LABEL } from '../labels'
import type { SliceSectionProps } from '../sectionRegistry'

const NOOP = () => {}

function Preview({ bundle }: { bundle: ShipmentBundle }) {
  const load = bundle.loads[0] ?? null
  const leg = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const tracking = useLoadTracking({
    loadId: load?.id,
    shipmentId: bundle.shipment.id,
    truckId: leg?.truckId ?? null,
    load: { pickupAppt: load?.pickupAppt, deliveredAt: load?.deliveredAt },
    loadCarrier: { dispatchedAt: leg?.dispatchedAt },
  })
  const drivers = useAppStore((s) => s.drivers)
  const driver = leg?.driverId ? drivers.find((d) => d.id === leg.driverId) ?? null : null
  const phones = useDriverPhones(driver, {
    loadTruckId: leg?.truckId ?? null,
    legDriverPhone: leg?.driverPhone ?? null,
    unitNumber: leg?.truckNumber ?? null,
  })
  const summary = useMemo(
    () => summaryOf({ bundle, phones, lastKnown: tracking.lastKnown, nowMs: tracking.nowMs }),
    [bundle, phones, tracking.lastKnown, tracking.nowMs],
  )
  return (
    <>
      <TrackingSummaryStrip summary={summary} busy onSetNextCheck={NOOP} />
      <RecentCheckCalls events={tracking.events} busy onResolve={NOOP} />
    </>
  )
}

function CheckCallsSectionImpl({ ctx }: SliceSectionProps<'checkCall'>) {
  const bundle = ctx.mode === 'edit' ? ctx.bundle : null
  return (
    <div className="space-y-2" data-testid="section-checkCalls-body">
      {bundle ? (
        <>
          <Preview bundle={bundle} />
          <Link
            to={`/tms/tracking?shipment=${bundle.shipment.id}`}
            className="text-xs underline"
            data-testid={LABEL.checkCalls.add.testId}
          >
            Open in Load Tracking
          </Link>
        </>
      ) : (
        <p className="tms-muted text-sm" data-testid="checkcalls-after-create">
          Check calls are available after the shipment is created.
        </p>
      )}
    </div>
  )
}

export const CheckCallsSection = memo(CheckCallsSectionImpl)
