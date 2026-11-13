/**
 * The covering carrier, once the load is covered: one card in the style of the MyCarrierPackets
 * lookup card (CarrierLookupCard) instead of a grid of read-only "—" boxes. Everything here is
 * read from the Carrier row, which the MyCarrierPackets sync fills (insurance, safety, risk, contacts),
 * plus the assignment's rate con dates and the trip the form holds (driver, truck, trailer).
 */
import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { formatBoardDate } from '@/lib/date'
import type { CarrierRecord, LoadCarrierRecord } from '@/types/tms'
import { insuranceLines } from './coveredCarrierModel'
import './coveredCarrierCard.css'

function cityState(address: CarrierRecord['address']): string {
  const a = (address ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  return [s('city'), s('state')].filter(Boolean).join(', ')
}

/** What the form holds for the trip; only the filled parts show. */
export interface CoveredTrip {
  driver?: string
  driverPhone?: string
  truckNo?: string
  trailerNo?: string
}

interface Props {
  carrier: CarrierRecord
  testId?: string
  assignment?: Pick<LoadCarrierRecord, 'rateConSentAt' | 'rateConSignedAt'> | null
  trip?: CoveredTrip
}

export function CoveredCarrierCard({ carrier, testId = 'carrier-covered-card', assignment, trip }: Props) {
  const standing = effectiveCarrierStatus(carrier, new Date())
  const ids = [
    carrier.mcNumber && `MC ${carrier.mcNumber}`,
    carrier.dotNumber && `DOT ${carrier.dotNumber}`,
    carrier.scac && `SCAC ${carrier.scac}`,
  ].filter(Boolean).join(' · ')
  const contacts = [
    carrier.dispatcherName && `Dispatch ${carrier.dispatcherName}`,
    carrier.dispatcherPhone, carrier.dispatcherEmail,
    carrier.phone, carrier.email,
  ].filter((v, i, all) => v && all.indexOf(v) === i).join(' · ')
  const vetting = [
    carrier.safetyRating && `Safety ${carrier.safetyRating.toLowerCase().replace(/_/g, ' ')}`,
    carrier.mcpRiskScore != null && `Risk ${carrier.mcpRiskScore} pts`,
    carrier.mcpSyncedAt ? `MyCarrierPackets synced ${formatBoardDate(carrier.mcpSyncedAt)}` : 'Not synced from MyCarrierPackets yet',
  ].filter(Boolean).join(' · ')
  const where = cityState(carrier.address)
  const tripBits = [
    trip?.driver && `Driver ${trip.driver}${trip.driverPhone ? ` ${trip.driverPhone}` : ''}`,
    trip?.truckNo && `Truck ${trip.truckNo}`,
    trip?.trailerNo && `Trailer ${trip.trailerNo}`,
  ].filter(Boolean) as string[]
  const rateCon = assignment?.rateConSignedAt
    ? { tone: 'green' as const, text: `Rate con signed ${formatBoardDate(assignment.rateConSignedAt)}` }
    : assignment?.rateConSentAt
      ? { tone: 'blue' as const, text: `Rate con sent ${formatBoardDate(assignment.rateConSentAt)}` }
      : assignment ? { tone: 'orange' as const, text: 'Rate con not sent' } : null

  return (
    <div className="tms-covered-card" data-testid={testId}>
      <div className="tms-covered-card-head">
        <div className="tms-covered-card-who">
          <strong className="tms-covered-card-name" data-testid={`${testId}-name`}>{carrier.name}</strong>
          {(ids || where) && (
            <span className="tms-muted" data-testid={`${testId}-ids`}>{[ids, where].filter(Boolean).join(' · ')}</span>
          )}
        </div>
        <div className="tms-covered-card-pills">
          <TmsBadge tone={standing.status === 'ACTIVE' ? 'green' : standing.status === 'DO_NOT_USE' ? 'red' : 'orange'} data-testid={`${testId}-status`}>
            {standing.status === 'ACTIVE' ? 'Set up · Active' : `Set up · ${CARRIER_STATUS_LABELS[standing.status]}`}
          </TmsBadge>
          {rateCon && <TmsBadge tone={rateCon.tone} data-testid={`${testId}-ratecon`}>{rateCon.text}</TmsBadge>}
          <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/carriers/${carrier.id}`} data-testid={`${testId}-open`}>
            Open carrier
          </Link>
        </div>
      </div>

      <div className="tms-covered-card-grid">
        <section className="tms-covered-card-block" data-testid={`${testId}-insurance`}>
          <span className="tms-covered-card-label">Insurance</span>
          {insuranceLines(carrier).map((l) => (
            <span key={l.type} className="tms-covered-card-line" data-testid={`${testId}-insurance-${l.type}`}>
              <span className="tms-muted">{l.label}</span>{' '}
              <span className={l.tone === 'bad' ? 'tms-covered-card-bad' : undefined}>{l.text}</span>
            </span>
          ))}
        </section>
        <section className="tms-covered-card-block">
          {tripBits.length > 0 && (
            <>
              <span className="tms-covered-card-label">Trip</span>
              <span data-testid={`${testId}-trip`}>{tripBits.join(' · ')}</span>
            </>
          )}
          {contacts && (
            <>
              <span className="tms-covered-card-label">Contacts</span>
              <span data-testid={`${testId}-contacts`}>{contacts}</span>
            </>
          )}
          <span className="tms-covered-card-label">Vetting</span>
          <span className="tms-muted" data-testid={`${testId}-vetting`}>{vetting}</span>
        </section>
      </div>
    </div>
  )
}
