/**
 * The MyCarrierPackets review screen, as a card: header with name / MC / DOT / status chips, the risk
 * gauge with its breakdown, the insurance table, the authority timeline, contacts and approved
 * e-mails. Presentational only; the page owns every action.
 */
import type { ReactNode } from 'react'
import { TmsAlert, TmsBadge, TmsCard, TmsMetaList } from '@/features/tms/kit'
import { TmsGauge } from '@/features/tms/kit/TmsGauge'
import type { TmsTone } from '@/features/tms/kit'
import { formatCents } from '@/lib/tmsDirectory'
import { refLabel, type McpReviewCard, type ReviewTone } from '@/lib/integrations/mcpReview'

const BADGE: Record<ReviewTone, TmsTone> = { green: 'green', amber: 'orange', red: 'red', gray: 'gray' }
const GAUGE: Record<ReviewTone, 'default' | 'good' | 'warn' | 'bad'> = { green: 'good', amber: 'warn', red: 'bad', gray: 'default' }
/** Points at which the gauge reads full: 10,000 (Ryne 2026-11-09). MCP publishes no ceiling; this is only the dial's scale. */
const GAUGE_FULL_SCALE = 10000

const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '—')

const INSURANCE_TONE: Record<string, TmsTone> = { ACTIVE: 'green', EXPIRED: 'red', CANCELLED: 'red', UNKNOWN: 'gray' }

function statusTone(status: string | undefined): ReviewTone {
  const s = (status ?? '').toLowerCase()
  if (!s) return 'gray'
  if (/active|authorized|ok/.test(s) && !/in.?active|not/.test(s)) return 'green'
  if (/inactive|revoked|out|not|denied/.test(s)) return 'red'
  return 'amber'
}

function packetTone(status: McpReviewCard['packet']['status']): ReviewTone {
  if (status === 'ACCEPTABLE') return 'green'
  if (status === 'MODERATE' || status === 'PENDING_REVIEW' || status === 'IN_PROGRESS' || status === 'INVITED') return 'amber'
  if (status === 'UNACCEPTABLE' || status === 'UNACCEPTABLE_REVIEW') return 'red'
  return 'gray'
}

export function McpReviewCardView({ card, actions, banner }: { card: McpReviewCard; actions?: ReactNode; banner?: ReactNode }) {
  const { identity, operating, risk, packet } = card
  const title = identity.legalName ?? refLabel(identity)
  const points = risk.totalPoints
  return (
    <div className="flex flex-col gap-3" data-testid="mcp-review-card" data-source={card.source}>
      {card.source === 'STUB' && (
        <TmsAlert tone="orange" title="STUB: sample data, not this carrier" role="status">
          MyCarrierPackets is not LIVE here, so this card is a labelled fixture. Nothing was looked up, nothing can be invited and nothing can be added.
        </TmsAlert>
      )}
      {banner}

      <TmsCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 style={{ margin: 0, fontSize: 18 }} data-testid="mcp-card-name">{title}</h2>
            {identity.dbaName && <div className="tms-muted">DBA {identity.dbaName}</div>}
            <div className="tms-muted" style={{ fontSize: 13 }}>{refLabel(identity)}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1" data-testid="mcp-card-chips">
              {operating.status && <TmsBadge tone={BADGE[statusTone(operating.status)]}>Operating: {operating.status}</TmsBadge>}
              {operating.authorityStatus && (
                <TmsBadge tone={operating.authorityStatus === 'ACTIVE' ? 'green' : 'red'}>Authority {operating.authorityStatus.toLowerCase()}</TmsBadge>
              )}
              {operating.safetyRating && <TmsBadge tone="gray">Safety: {operating.safetyRating}</TmsBadge>}
              <TmsBadge tone={BADGE[packetTone(packet.status)]}>{packet.label}</TmsBadge>
              {card.monitoring.monitored === true && <TmsBadge tone="blue">Monitored</TmsBadge>}
              {card.monitoring.monitored === false && <TmsBadge tone="gray">Not monitored</TmsBadge>}
              {card.monitoring.blocked === true && <TmsBadge tone="red">Blocked by us</TmsBadge>}
              {operating.possibleFraud && /^y/i.test(operating.possibleFraud) && <TmsBadge tone="red">Possible fraud</TmsBadge>}
              {operating.doubleBrokering && /^y/i.test(operating.doubleBrokering) && <TmsBadge tone="red">Double brokering</TmsBadge>}
              {operating.nonCooperative === true && <TmsBadge tone="red">Insurance non-coop</TmsBadge>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </TmsCard>

      <div className="grid gap-3 min-[1100px]:grid-cols-[minmax(240px,300px)_1fr]">
        <TmsCard title="Risk assessment">
          <div className="flex flex-col items-center gap-2" data-testid="mcp-card-risk">
            <TmsGauge
              size={180}
              value={points == null ? null : points / GAUGE_FULL_SCALE}
              label={points == null ? '—' : String(points)}
              sub={risk.overallRating ?? 'No rating'}
              tone={GAUGE[risk.tone]}
              ariaLabel={`Risk assessment ${points ?? 'not available'} points, ${risk.overallRating ?? 'no rating'}`}
            />
            {risk.reviewState && <TmsBadge tone="gray">Review: {risk.reviewState}</TmsBadge>}
          </div>
          <ul className="mt-2 flex flex-col gap-1" style={{ listStyle: 'none', padding: 0 }}>
            {risk.categories.map((c) => (
              <li key={c.key} data-testid={`mcp-risk-${c.key}`}>
                <div className="flex items-center justify-between gap-2">
                  <span>{c.label}</span>
                  <span className="flex items-center gap-1">
                    {c.points != null && <span className="tms-muted">{c.points} pts</span>}
                    {c.rating && <TmsBadge tone={BADGE[c.tone]}>{c.rating}</TmsBadge>}
                  </span>
                </div>
                {c.infractions.map((i) => <div key={i} className="tms-muted" style={{ fontSize: 12, paddingLeft: 8 }}>{i}</div>)}
              </li>
            ))}
            {risk.categories.length === 0 && <li className="tms-muted">MyCarrierPackets returned no breakdown.</li>}
          </ul>
          {risk.review && (
            <p className="tms-muted" style={{ fontSize: 12, marginTop: 8 }}>
              Reviewed {day(risk.review.date)}{risk.review.user ? ` by ${risk.review.user}` : ''}{risk.review.reason ? `: ${risk.review.reason}` : ''}{risk.review.note ? ` (${risk.review.note})` : ''}
            </p>
          )}
        </TmsCard>

        <div className="flex flex-col gap-3">
          <TmsCard title="Insurance" flush>
            <table className="tms-table w-full" data-testid="mcp-card-insurance">
              <thead>
                <tr><th>Coverage</th><th>Insurer</th><th>Policy</th><th>Limit</th><th>Expires</th><th>State</th></tr>
              </thead>
              <tbody>
                {card.insurance.map((r, i) => (
                  <tr key={`${r.type}-${r.policyNumber ?? i}`}>
                    <td>{r.type}</td>
                    <td>{r.insurer ?? '—'}</td>
                    <td>{r.policyNumber ?? '—'}</td>
                    <td>{r.limitCents != null ? `$${formatCents(r.limitCents)}` : (r.limitText ?? '—')}</td>
                    <td>{day(r.expiresAt)}</td>
                    <td><TmsBadge tone={INSURANCE_TONE[r.state]}>{r.state.toLowerCase()}</TmsBadge></td>
                  </tr>
                ))}
                {card.insurance.length === 0 && <tr><td colSpan={6} className="tms-muted">No certificate on file at MyCarrierPackets.</td></tr>}
              </tbody>
            </table>
          </TmsCard>

          <TmsCard title="Authority & FMCSA">
            <TmsMetaList
              columns={3}
              dense
              items={[
                { label: 'Common authority', value: operating.common },
                { label: 'Contract authority', value: operating.contract },
                { label: 'Broker authority', value: operating.broker },
                { label: 'Operating status', value: operating.status ? `${operating.status}${operating.statusDate ? ` since ${day(operating.statusDate)}` : ''}` : undefined },
                { label: 'Safety rating', value: operating.safetyRating ? `${operating.safetyRating}${operating.safetyRatingDate ? ` (${day(operating.safetyRatingDate)})` : ''}` : undefined },
                { label: 'In process', value: operating.inProcessState },
                { label: 'Incident reports', value: operating.incidentReports ? `${operating.incidentReports.total} (${operating.incidentReports.withFraud} with fraud)` : undefined },
                { label: 'Intrastate only', value: operating.intrastate == null ? undefined : operating.intrastate ? 'Yes' : 'No' },
                { label: 'FreightValidate', value: operating.freightValidate },
              ]}
            />
            <ol className="mt-3 flex flex-col gap-1" style={{ listStyle: 'none', padding: 0 }} data-testid="mcp-card-timeline">
              {card.timeline.map((t, i) => (
                <li key={`${t.label}-${i}`} className="flex gap-2">
                  <span className="tms-muted" style={{ minWidth: 84 }}>{day(t.at)}</span>
                  <span>{t.label}{t.detail ? <span className="tms-muted"> · {t.detail}</span> : null}</span>
                </li>
              ))}
              {card.timeline.length === 0 && <li className="tms-muted">No dated events.</li>}
            </ol>
          </TmsCard>
        </div>
      </div>

      <div className="grid gap-3 min-[1100px]:grid-cols-2">
        <TmsCard title="Contacts">
          <TmsMetaList
            columns={2}
            dense
            items={[
              { label: 'Phone', value: identity.phone },
              { label: 'E-mail', value: identity.email },
              { label: 'Website', value: identity.website },
              { label: 'Address', value: identity.address, wide: true },
            ]}
          />
          <ul className="mt-2 flex flex-col gap-1" style={{ listStyle: 'none', padding: 0 }} data-testid="mcp-card-contacts">
            {card.contacts.map((c) => (
              <li key={`${c.email ?? c.name}`}>
                <strong>{c.name}</strong>
                <span className="tms-muted"> {[c.types.join(', ').toLowerCase(), c.phone, c.email].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider tms-muted">Approved e-mails</p>
          <ul style={{ listStyle: 'none', padding: 0 }} data-testid="mcp-card-approved">
            {card.approvedEmails.map((e) => <li key={e.email}>{e.email}{e.description ? <span className="tms-muted"> · {e.description}</span> : null}</li>)}
            {card.approvedEmails.length === 0 && <li className="tms-muted">MyCarrierPackets has no approved e-mail for this carrier yet; type one to invite.</li>}
          </ul>
        </TmsCard>

        <TmsCard title="Packet, equipment & lanes">
          <TmsMetaList
            columns={2}
            dense
            items={[
              { label: 'Packet', value: packet.label },
              { label: 'MCP status text', value: packet.rawStatuses.join(', ') || undefined },
              { label: 'Completed', value: packet.completedAt ? day(packet.completedAt) : undefined },
              { label: 'Last invitation', value: packet.invitedAt ? `${day(packet.invitedAt)}${packet.invitedTo ? ` to ${packet.invitedTo}` : ''}` : undefined },
              { label: 'On our agreement', value: packet.onCurrentAgreement == null ? undefined : packet.onCurrentAgreement ? 'Yes' : 'No' },
              { label: 'Rating', value: packet.rating },
              { label: 'Power units', value: card.equipment.powerUnits },
              { label: 'Tractors / trailers', value: card.equipment.tractors || card.equipment.trailers ? `${card.equipment.tractors ?? 0} / ${card.equipment.trailers ?? 0}` : undefined },
              { label: 'Drivers', value: card.equipment.drivers },
              { label: 'ELD', value: card.equipment.eld },
              { label: 'Modes', value: card.equipment.modes.join(', ') || undefined, wide: true },
              { label: 'Cargo hauled', value: card.equipment.cargo.join(', ') || undefined, wide: true },
              { label: 'Lanes', value: card.equipment.lanes.join(', ') || undefined, wide: true },
            ]}
          />
        </TmsCard>
      </div>
    </div>
  )
}
