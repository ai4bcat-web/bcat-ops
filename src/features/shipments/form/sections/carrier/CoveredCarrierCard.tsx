/**
 * The covering carrier, once the load is covered: one card in the style of the MyCarrierPackets
 * lookup card (CarrierLookupCard) instead of a grid of read-only "—" boxes. Everything here is
 * read from the Carrier row, which the MyCarrierPackets sync fills (insurance, safety, risk, contacts).
 */
import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { formatBoardDate } from '@/lib/date'
import type { CarrierRecord } from '@/types/tms'
import { insuranceLines } from './coveredCarrierModel'

function cityState(address: CarrierRecord['address']): string {
  const a = (address ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  return [s('city'), s('state')].filter(Boolean).join(', ')
}

export function CoveredCarrierCard({ carrier, testId = 'carrier-covered-card' }: { carrier: CarrierRecord; testId?: string }) {
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

  return (
    <div data-testid={testId}
      style={{ display: 'grid', gap: 8, border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 10, fontSize: 13 }}>
      <div className="flex flex-wrap items-center gap-2">
        <strong data-testid={`${testId}-name`}>{carrier.name}</strong>
        <TmsBadge tone={standing.status === 'ACTIVE' ? 'green' : standing.status === 'DO_NOT_USE' ? 'red' : 'orange'} data-testid={`${testId}-status`}>
          {standing.status === 'ACTIVE' ? 'Set up · Active' : `Set up · ${CARRIER_STATUS_LABELS[standing.status]}`}
        </TmsBadge>
        <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/carriers/${carrier.id}`} data-testid={`${testId}-open`} style={{ marginLeft: 'auto' }}>
          Open carrier
        </Link>
      </div>
      {(ids || where) && (
        <span className="tms-muted" data-testid={`${testId}-ids`}>{[ids, where].filter(Boolean).join(' · ')}</span>
      )}
      <div style={{ display: 'grid', gap: 2 }} data-testid={`${testId}-insurance`}>
        {insuranceLines(carrier).map((l) => (
          <span key={l.type} data-testid={`${testId}-insurance-${l.type}`}>
            <span className="tms-muted">{l.label}</span>{' '}
            <span style={l.tone === 'bad' ? { color: 'var(--tms-badge-red)' } : undefined}>{l.text}</span>
          </span>
        ))}
      </div>
      <span className="tms-muted" data-testid={`${testId}-vetting`}>{vetting}</span>
      {contacts && <span className="tms-muted" data-testid={`${testId}-contacts`}>{contacts}</span>}
    </div>
  )
}
