/**
 * Card 8: Tracking (Step AR). READ-ONLY, high level, pulled from the Load Tracking page.
 *  - Edit mode: status chip, tracking mode / method / assignee, the summary strip (position + age,
 *    ETA, next check call, POD), the last check call, recent check calls, "Open in Load Tracking",
 *    and the Updates feed (formerly in the More strip).
 *  - Create mode (no load yet): the planned setup: the customer's default tracking mode, method
 *    and driver-SMS target, the Step V automation that will apply, and "Tracking starts when the
 *    load is covered".
 * Nothing here writes; the strip's reminder menu is inert (`busy`), logging happens in Load Tracking.
 * It adds no reads of its own beyond the per-load tracking hook the AH preview already used.
 */
import { memo, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, statusTone } from '@/features/tms/kit'
import { useLoadTracking } from '@/hooks/useLoadTracking'
import { useDriverPhones } from '@/hooks/useTruckConfigs'
import { CHECK_CALL_TYPE_LABELS } from '@/lib/checkCalls'
import { formatBoardDateTime } from '@/lib/date'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { resolveAutomation } from '@/lib/trackingAutomation'
import {
  DRIVER_SMS_TARGET_LABELS, TRACKING_METHOD_LABELS, TRACKING_MODE_LABELS, effectiveTrackingPrefs,
  type EffectiveTrackingPrefs,
} from '@/lib/trackingPrefs'
import { useAppStore } from '@/store/useAppStore'
import type { ShipmentBundle } from '@/types/tms'
import { RecentCheckCalls } from '../../workstations/tracking/RecentCheckCalls'
import { TrackingSummaryStrip } from '../../workstations/tracking/TrackingSummaryStrip'
import { summaryOf } from '../../workstations/tracking/trackingSummary'
import type { FormCtx } from '../sectionProps'
import type { CardProps } from './cardRegistry'
import { UpdatesTab } from './more/UpdatesTab'
import './trackDocsCards.css'

const NOOP = () => {}
const SHORT_MODE = { AGENT: 'AI agent', MANUAL: 'Manual' } as const
const SHORT_METHOD = { EMAIL: 'E-mail', SMS: 'SMS', BOTH: 'E-mail + SMS' } as const

function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="tms-card-fact">
      <span className="tms-card-cap">{label}</span>
      <span className="tms-card-fact-value" data-testid={testId}>{children}</span>
    </div>
  )
}

/** "AI agent · E-mail + SMS · work phone, then personal" */
function setupText(p: EffectiveTrackingPrefs): string {
  return [p.mode ? SHORT_MODE[p.mode] : 'not set', p.method ? SHORT_METHOD[p.method] : 'plan channels', DRIVER_SMS_TARGET_LABELS[p.driverSms].toLowerCase()].join(' · ')
}

function EditBody(props: CardProps & { bundle: ShipmentBundle }) {
  const { bundle, ctx } = props
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
  const prefs = effectiveTrackingPrefs({ shipment: bundle.shipment, customer: ctx.customer })
  const assignee = bundle.shipment.trackerId
    ? ctx.directory.staff.find((s) => s.id === bundle.shipment.trackerId) ?? null
    : null
  const last = [...tracking.events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
  const lastPlace = last ? [last.city, last.state].filter(Boolean).join(', ') : ''

  return (
    <>
      <div className="tms-card-facts" data-testid="card-tracking-facts">
        <Fact label="Status" testId="card-tracking-status">
          <TmsBadge tone={statusTone(bundle.shipment.status)}>{SHIPMENT_STATUS_LABELS[bundle.shipment.status] ?? bundle.shipment.status}</TmsBadge>
        </Fact>
        <Fact label="Tracking" testId="card-tracking-method">{setupText(prefs)}</Fact>
        <Fact label="Assignee" testId="card-tracking-assignee">
          {assignee ? assignee.name || assignee.email : <span className="tms-muted">Unassigned</span>}
        </Fact>
        <Fact label="Last check call" testId="card-tracking-last-call">
          {last ? (
            <>
              {formatBoardDateTime(last.at)}
              {lastPlace ? ` · ${lastPlace}` : ''}
              {' · '}{CHECK_CALL_TYPE_LABELS[last.type] ?? last.type}
              {last.note ? <span className="tms-muted"> · {last.note}</span> : null}
            </>
          ) : <span className="tms-muted">None logged yet</span>}
        </Fact>
      </div>
      <TrackingSummaryStrip summary={summary} busy onSetNextCheck={NOOP} />
      <RecentCheckCalls events={tracking.events} busy onResolve={NOOP} />
      <Link
        to={`/tms/tracking?shipment=${bundle.shipment.id}`}
        className="text-xs underline"
        data-testid="card-tracking-open"
      >
        Open in Load Tracking
      </Link>
      <div className="tms-card-req" data-testid="card-tracking-updates">
        <div className="tms-card-req-title">Updates</div>
        <UpdatesTab {...props} />
      </div>
    </>
  )
}

function automationLine(ctx: FormCtx, revDivision: string): string[] {
  const { policy } = resolveAutomation({ settings: ctx.settings, customer: ctx.customer, revDivision })
  return [
    policy.checkCallsAuto ? 'Automatic check calls on' : 'Automatic check calls off',
    policy.podAuto ? `Automatic POD requests on (${policy.podChannels.map((c) => (c === 'SMS' ? 'text' : 'e-mail')).join(' + ')})` : 'Automatic POD requests off',
    policy.quietHours.enabled ? `Quiet hours ${policy.quietHours.start}–${policy.quietHours.end} (${policy.quietHours.channels.map((c) => (c === 'SMS' ? 'text' : 'e-mail')).join(', ')})` : 'No quiet hours',
  ]
}

function PlannedBody({ values, ctx }: CardProps) {
  const prefs = effectiveTrackingPrefs({ customer: ctx.customer })
  const lines = automationLine(ctx, values.ship.revDivision)
  return (
    <>
      <div className="tms-card-facts" data-testid="card-tracking-planned">
        <Fact label="Tracking mode" testId="card-tracking-planned-mode">
          {prefs.mode ? TRACKING_MODE_LABELS[prefs.mode] : <span className="tms-muted">{ctx.customer ? 'Not set for this customer' : 'Pick a customer'}</span>}
        </Fact>
        <Fact label="Tracking method" testId="card-tracking-planned-method">
          {prefs.method ? TRACKING_METHOD_LABELS[prefs.method] : <span className="tms-muted">Plan channels</span>}
        </Fact>
        <Fact label="Driver SMS to" testId="card-tracking-planned-sms">{DRIVER_SMS_TARGET_LABELS[prefs.driverSms]}</Fact>
        <Fact label="Automation that will apply" testId="card-tracking-planned-automation">
          <ul className="tms-card-docs-checklist">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </Fact>
      </div>
      <p className="tms-muted text-sm" data-testid="card-tracking-after-create">Tracking starts when the load is covered.</p>
    </>
  )
}

function TrackingCardImpl(props: CardProps) {
  const bundle = props.ctx.mode === 'edit' ? props.ctx.bundle : null
  return (
    <div className="tms-card-body-stack" data-testid="card-tracking-body">
      {bundle ? <EditBody {...props} bundle={bundle} /> : <PlannedBody {...props} />}
    </div>
  )
}

export const TrackingCard = memo(TrackingCardImpl)
