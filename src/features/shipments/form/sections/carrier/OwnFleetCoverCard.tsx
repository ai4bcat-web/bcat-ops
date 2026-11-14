/**
 * Ivan Cartage (own fleet) in Carrier & Tracking: one "Covered by" card in place of the outside-carrier grid (MC, DOT,
 * insurance, carrier e-mail), none of which an own-fleet load has. Ryne 2026-11-14: "for loads that are covered by ivan
 * cartage, just populate this section with the driver info ... shows covered by ivan local drivers or covered by owner
 * operators".
 *   header  group badge (Owner Operator / Local Driver / Box Truck) · "Covered by Ivan Cartage" · Driver settlement
 *   body    the driver: avatar, name, truck, trailer, cell, e-mail, last position, ETA, POD; the delivery driver when split
 *   picker  the Driver 1 picker (and the delivery-driver option) the section hands in as children
 * With no driver yet the body is "Assign a driver" and the picker sits right under it.
 * Presentational: the section decides the group, reads the trip and passes the picker.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, type TmsTone } from '@/features/tms/kit'
import { prettyPhone } from '@/lib/dispatch'
import { OWN_FLEET_COVER_LABEL, driverInitials, pingAgeText, type OwnFleetCoverKind } from '@/lib/ownFleetCoverage'
import { POD_LABELS } from '../../../workstations/tracking/trackingColumns'
import { etaText, type TrackingSummary } from '../../../workstations/tracking/trackingSummary'
import './ownFleetCoverCard.css'

/** Each group keeps one accent: the settlements avatars are purple for owner operators. */
const KIND_TONE: Record<OwnFleetCoverKind, TmsTone> = { OWNER_OPERATOR: 'purple', LOCAL: 'turquoise', BOX_TRUCK: 'blue' }
const POD_TONE: Record<string, TmsTone> = { NEEDED: 'orange', REQUESTED: 'blue', IN_REVIEW: 'blue', RECEIVED: 'green', UNKNOWN: 'gray' }

export interface OwnFleetCoverDriver {
  name: string
  phone: string
  email: string
  truckNo: string
  trailerNo: string
}

interface Props {
  kind: OwnFleetCoverKind | null
  driver: OwnFleetCoverDriver
  /** The delivery driver's name when a second driver takes the delivery. */
  deliveryDriver?: string | null
  /** Covered = the assignment exists; otherwise the driver is only picked on the form. */
  covered: boolean
  /** Saved shipments only: last position, ETA and POD. */
  summary?: Pick<TrackingSummary, 'lastKnown' | 'eta' | 'pod'> | null
  /** Owner operators: their settlement week for this load. */
  settlementHref?: string | null
  /** Header control (e.g. clear the carrier) while the picker is still open. */
  headerAction?: ReactNode
  /** The Driver 1 picker and the delivery-driver option. */
  children?: ReactNode
  testId?: string
}

function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="tms-ofc-fact" data-testid={testId}>
      <span className="tms-ofc-fact-label">{label}</span>
      <span className="tms-ofc-fact-value">{children}</span>
    </div>
  )
}

export function OwnFleetCoverCard({
  kind, driver, deliveryDriver, covered, summary, settlementHref, headerAction, children, testId = 'carrier-own-fleet-card',
}: Props) {
  const name = driver.name.trim()
  const accent = kind ? `tms-ofc--${kind.toLowerCase().replace('_', '-')}` : 'tms-ofc--generic'
  const place = summary?.lastKnown
    ? [summary.lastKnown.place, pingAgeText(summary.lastKnown.ageMinutes)].filter(Boolean).join(' · ')
    : ''
  const pod = summary?.pod ?? null

  return (
    <div className={`tms-ofc ${accent}`} data-testid={testId} data-kind={kind ?? 'UNKNOWN'}>
      <div className="tms-ofc-head">
        {kind ? (
          <TmsBadge tone={KIND_TONE[kind]} data-testid={`${testId}-kind`}>{OWN_FLEET_COVER_LABEL[kind]}</TmsBadge>
        ) : null}
        <span className="tms-ofc-title" data-testid={`${testId}-title`}>Covered by Ivan Cartage</span>
        <TmsBadge tone={covered ? 'green' : 'gray'} data-testid={`${testId}-state`}>{covered ? 'Covered' : 'Not covered yet'}</TmsBadge>
        <span className="tms-ofc-head-end">
          {settlementHref ? (
            <Link className="tms-ofc-link" to={settlementHref} data-testid={`${testId}-settlement`}>Driver settlement</Link>
          ) : null}
          {headerAction}
        </span>
      </div>

      {name ? (
        <div className="tms-ofc-body" data-testid={`${testId}-driver`}>
          <span className="tms-ofc-avatar" aria-hidden="true">{driverInitials(name)}</span>
          <div className="tms-ofc-who">
            <strong className="tms-ofc-name" data-testid={`${testId}-name`}>{name}</strong>
            <span className="tms-ofc-units" data-testid={`${testId}-units`}>
              {driver.truckNo ? `Truck ${driver.truckNo}` : 'No truck'}
              {' · '}
              {driver.trailerNo ? `Trailer ${driver.trailerNo}` : 'No trailer'}
            </span>
            {deliveryDriver ? (
              <span className="tms-ofc-units" data-testid={`${testId}-delivery-driver`}>Delivery: {deliveryDriver}</span>
            ) : null}
          </div>
          <div className="tms-ofc-facts">
            <Fact label="Cell" testId={`${testId}-cell`}>
              {driver.phone ? <a href={`tel:${driver.phone}`}>{prettyPhone(driver.phone) || driver.phone}</a> : <span className="tms-muted">—</span>}
            </Fact>
            <Fact label="E-mail" testId={`${testId}-email`}>
              {driver.email ? <a href={`mailto:${driver.email}`}>{driver.email}</a> : <span className="tms-muted">—</span>}
            </Fact>
            {summary !== undefined ? (
              <>
                <Fact label="Last position" testId={`${testId}-position`}>
                  {place || <span className="tms-muted">No position yet</span>}
                </Fact>
                <Fact label="ETA" testId={`${testId}-eta`}>
                  {summary?.eta ? etaText(summary.eta) : <span className="tms-muted">—</span>}
                </Fact>
                <Fact label="POD" testId={`${testId}-pod`}>
                  {pod ? <TmsBadge tone={POD_TONE[pod] ?? 'gray'}>{POD_LABELS[pod]}</TmsBadge> : <span className="tms-muted">Not due</span>}
                </Fact>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="tms-ofc-empty" data-testid={`${testId}-empty`}>
          <span className="tms-ofc-avatar tms-ofc-avatar--empty" aria-hidden="true">?</span>
          <div>
            <strong className="tms-ofc-name">Assign a driver</strong>
            <p className="tms-muted text-xs">Pick who drives this load. Their truck, trailer and cell fill in from their driver record.</p>
          </div>
        </div>
      )}

      {children ? <div className="tms-ofc-picker" data-testid={`${testId}-picker`}>{children}</div> : null}
    </div>
  )
}
