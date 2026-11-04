/**
 * One nowrap line of the facts a tracker reads first. Every segment truncates (the full
 * text is in its tooltip) so the strip never wraps and never pushes the panes down. An
 * optional second line (`prefs`) holds the always-visible tracking-prefs row.
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, Clock, MapPin, Truck } from 'lucide-react'
import { DriverPhones } from '@/components/DriverPhones'
import { prettyPhone } from '@/lib/dispatch'
import { TmsBadge, TmsButton, TmsInput, type TmsTone } from '@/features/tms/kit'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import type { CheckCallState } from '@/lib/checkCalls'
import { durationText } from './trackingTable'
import { POD_LABELS } from './trackingColumns'
import { etaText, type TrackingSummary } from './trackingSummary'

const NEXT_CHECK_TONE: Record<CheckCallState, TmsTone> = { NONE: 'gray', SCHEDULED: 'gray', DUE: 'orange', OVERDUE: 'red' }
const POD_TONE: Record<string, TmsTone> = { NEEDED: 'orange', REQUESTED: 'blue', IN_REVIEW: 'blue', RECEIVED: 'green', UNKNOWN: 'gray' }

function Segment({ testId, title, grow, children }: { testId?: string; title?: string; grow?: boolean; children: ReactNode }) {
  return (
    <span className="tms-strip-seg" data-testid={testId} title={title} style={grow ? { flexShrink: 3 } : undefined}>
      {children}
    </span>
  )
}

/** "14 min ago" / "3 h ago" / "2 d ago" for an age in minutes. */
function ageText(minutes: number | null): string | null {
  if (minutes == null) return null
  if (minutes < 1) return 'just now'
  return `${durationText(minutes).replace(/^(\d+) m$/, '$1 min')} ago`
}

function nextCheckText(next: TrackingSummary['nextCheck']): string {
  if (next.state === 'NONE' || next.minutes == null) return 'none scheduled'
  if (next.state === 'SCHEDULED') return `in ${durationText(next.minutes)}`
  return next.state === 'OVERDUE' ? `overdue ${durationText(next.minutes)}` : 'due now'
}

export function TrackingSummaryStrip({ summary, busy, onSetNextCheck, prefs }: {
  summary: TrackingSummary
  busy: boolean
  /** `null` clears the reminder. */
  onSetNextCheck: (iso: string | null) => void
  /** Second line of the card (the inline tracking-prefs row). Absent = the strip is one line, as before. */
  prefs?: ReactNode
}) {
  const { driver, phones, lastKnown, eta, nextCheck, pod, carrier } = summary
  const [menu, setMenu] = useState<'closed' | 'open' | 'edit'>('closed')
  const [draft, setDraft] = useState('')

  const age = lastKnown ? ageText(lastKnown.ageMinutes) : null
  const lastText = lastKnown ? [lastKnown.place, age].filter(Boolean).join(' · ') : 'no position yet'
  const etaDisplay = eta ? etaText(eta) : '—'

  const apply = (iso: string | null) => { setMenu('closed'); onSetNextCheck(iso) }

  return (
    <div className="tms-strip" data-testid="tracking-strip">
      <div className="tms-strip-line">
        <Segment testId="strip-driver" title={`${driver.name ?? 'No driver'}${driver.truckNumber ? ` · Truck ${driver.truckNumber}` : ''}`}>
          <Truck size={12} aria-hidden /> <strong>{driver.name ?? 'No driver'}</strong>
          {driver.truckNumber ? <span className="tms-muted"> · Truck {driver.truckNumber}</span> : null}
        </Segment>
        <Segment testId="strip-phones" grow>
          <DriverPhones phones={phones} variant="inline" />
        </Segment>
        <Segment testId="last-known" title={lastKnown?.source ? `${lastText} · via ${lastKnown.source.replace(/_/g, ' ').toLowerCase()}` : lastText}>
          <MapPin size={12} aria-hidden /> {lastText}
        </Segment>
        <Segment testId="delivery-eta" title={eta?.lateMinutes ? `${eta.lateMinutes} min late` : undefined}>
          <Clock size={12} aria-hidden /> ETA {etaDisplay}
          {eta?.lateMinutes ? <TmsBadge tone="red">{durationText(eta.lateMinutes)} late</TmsBadge> : null}
        </Segment>
        <span className="tms-strip-seg tms-strip-menu-host" data-testid="strip-next-check">
          <TmsBadge tone={NEXT_CHECK_TONE[nextCheck.state]}>Next check {nextCheckText(nextCheck)}</TmsBadge>
          <button type="button" className="tms-icon-btn" aria-label="Check call reminder" aria-expanded={menu !== 'closed'}
            onClick={() => {
              setDraft(formatDateTimeInput(nextCheck.at ?? new Date().toISOString()))
              setMenu(menu === 'closed' ? 'open' : 'closed')
            }}>
            <ChevronDown size={12} aria-hidden />
          </button>
          {menu !== 'closed' && (
            <div className="tms-strip-menu" role="menu" data-testid="strip-next-check-menu">
              <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => apply(new Date(Date.now() + 3_600_000).toISOString())}>Snooze 1 h</TmsButton>
              <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => setMenu('edit')}>Edit reminder</TmsButton>
              <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => apply(null)}>No reminder</TmsButton>
              {menu === 'edit' && (
                <div className="tms-strip-menu-edit">
                  <TmsInput aria-label="Reminder time" type="datetime-local" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <TmsButton size="sm" variant="primary" disabled={busy} onClick={() => apply(draft ? fromDateTimeInput(draft) : null)}>Save</TmsButton>
                </div>
              )}
            </div>
          )}
        </span>
        <Segment testId="strip-pod">
          POD{' '}
          {pod ? <TmsBadge tone={POD_TONE[pod] ?? 'gray'}>{POD_LABELS[pod]}</TmsBadge> : <span className="tms-muted">—</span>}
        </Segment>
        <Segment testId="strip-carrier" title={[carrier.label, carrier.contactName, carrier.phone, carrier.email].filter(Boolean).join(' · ')}>
          <span>{[carrier.label, carrier.contactName].filter(Boolean).join(' · ')}</span>
          {carrier.phone ? <> · <a href={`tel:${carrier.phone}`} aria-label={`Call ${carrier.contactName ?? carrier.label}`}>{prettyPhone(carrier.phone)}</a></> : null}
          {carrier.email ? <> · <a href={`mailto:${carrier.email}`} aria-label={`E-mail ${carrier.contactName ?? carrier.label}`}>E-mail</a></> : null}
        </Segment>
      </div>
      {prefs ? <div className="tms-strip-line tms-strip-line-prefs">{prefs}</div> : null}
    </div>
  )
}
