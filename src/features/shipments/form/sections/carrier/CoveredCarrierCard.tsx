/**
 * The covering carrier, once the load is covered: one compact card (Ryne, 2026-11-13: "more concise").
 *   line 1  name · MC · DOT · status · rate con · Open carrier
 *   line 2  insurance chips ("Auto $1M · exp 06/01/27"), red when missing/expired, amber within 30 days
 *   line 3  driver · cell · truck · trailer · dispatcher — only the parts that are filled; omitted when empty
 * Everything is read from the Carrier row (the MyCarrierPackets sync fills it), the assignment's rate con
 * dates and the trip the form holds.
 */
import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { formatBoardDate } from '@/lib/date'
import type { CarrierRecord, LoadCarrierRecord } from '@/types/tms'
import { insuranceLines } from './coveredCarrierModel'
import './coveredCarrierCard.css'

/** What the form holds for the trip; only the filled parts show. */
export interface CoveredTrip {
  driver?: string
  driverPhone?: string
  truckNo?: string
  trailerNo?: string
  dispatcher?: string
  dispatcherPhone?: string
}

interface Props {
  carrier: CarrierRecord
  testId?: string
  assignment?: Pick<LoadCarrierRecord, 'rateConSentAt' | 'rateConSignedAt'> | null
  trip?: CoveredTrip
}

export function CoveredCarrierCard({ carrier, testId = 'carrier-covered-card', assignment, trip }: Props) {
  const standing = effectiveCarrierStatus(carrier, new Date())
  const ids = [carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`].filter(Boolean).join(' · ')
  const dispatcher = trip?.dispatcher || carrier.dispatcherName || ''
  const dispatcherPhone = trip?.dispatcherPhone || carrier.dispatcherPhone || ''
  const tripBits = [
    trip?.driver && `Driver ${trip.driver}`,
    trip?.driverPhone,
    trip?.truckNo && `Truck ${trip.truckNo}`,
    trip?.trailerNo && `Trailer ${trip.trailerNo}`,
    dispatcher && `Dispatch ${dispatcher}${dispatcherPhone ? ` ${dispatcherPhone}` : ''}`,
  ].filter(Boolean) as string[]
  const rateCon = assignment?.rateConSignedAt
    ? { tone: 'green' as const, text: `Rate con signed ${formatBoardDate(assignment.rateConSignedAt)}` }
    : assignment?.rateConSentAt
      ? { tone: 'blue' as const, text: `Rate con sent ${formatBoardDate(assignment.rateConSentAt)}` }
      : assignment ? { tone: 'orange' as const, text: 'Rate con not sent' } : null
  const chips = insuranceLines(carrier)

  return (
    <div className="tms-covered-card" data-testid={testId}>
      <div className="tms-covered-card-row">
        <strong className="tms-covered-card-name" data-testid={`${testId}-name`}>{carrier.name}</strong>
        {ids && <span className="tms-muted" data-testid={`${testId}-ids`}>{ids}</span>}
        <TmsBadge tone={standing.status === 'ACTIVE' ? 'green' : standing.status === 'DO_NOT_USE' ? 'red' : 'orange'} data-testid={`${testId}-status`}>
          {standing.status === 'ACTIVE' ? 'Active' : CARRIER_STATUS_LABELS[standing.status]}
        </TmsBadge>
        {rateCon && <TmsBadge tone={rateCon.tone} data-testid={`${testId}-ratecon`}>{rateCon.text}</TmsBadge>}
        <Link className="tms-covered-card-open" to={`/tms/carriers/${carrier.id}`} data-testid={`${testId}-open`}>Open carrier</Link>
      </div>
      {chips.length > 0 && (
        <div className="tms-covered-card-row" data-testid={`${testId}-insurance`}>
          {chips.map((c) => (
            <span key={c.type} className={`tms-covered-chip tms-covered-chip--${c.tone}`} data-testid={`${testId}-insurance-${c.type}`}>{c.text}</span>
          ))}
        </div>
      )}
      {tripBits.length > 0 && (
        <div className="tms-covered-card-row tms-covered-card-trip" data-testid={`${testId}-trip`}>{tripBits.join(' · ')}</div>
      )}
    </div>
  )
}
