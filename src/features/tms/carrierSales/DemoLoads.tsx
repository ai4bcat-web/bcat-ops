import { useState } from 'react'
import { Mail, Phone } from 'lucide-react'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { DEMO_SHIPMENTS, offerCount, summarize, type DemoShipment } from './demoOffers'
import { DemoBadge } from './CarrierOffersPanel'
import './carrierOffersPanel.css'

const STATUS: Record<ReturnType<typeof summarize>['status'], { label: string; tone: 'green' | 'blue' | 'red' | 'gray' }> = {
  BOOKED: { label: 'Booked', tone: 'green' },
  COUNTERED: { label: 'Countered', tone: 'blue' },
  DECLINED: { label: 'Declined', tone: 'red' },
  NO_DEAL: { label: 'No deal', tone: 'gray' },
}

/** DEMO loads, clearly labelled, each one opens the offers panel with fabricated voice + email offers. */
export function DemoLoads({ onOpen }: { onOpen: (s: DemoShipment) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="cs-demo-section" aria-label="Demo loads" data-testid="demo-loads">
      <div className="cs-demo-section-head">
        <DemoBadge />
        <strong>Demo loads</strong>
        <span className="cs-demo-section-note">Fake loads with fake voice and email offers. Click one to see its offers.</span>
        <span className="tms-dense-spacer" />
        <TmsButton size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide demo loads' : `Show demo loads (${DEMO_SHIPMENTS.length})`}</TmsButton>
      </div>
      {open && (
        <div className="cs-demo-list">
          {DEMO_SHIPMENTS.map((s) => {
            const c = offerCount(s)
            const st = STATUS[summarize(s).status]
            return (
              <button type="button" key={s.id} className="cs-demo-row" data-testid="demo-row" aria-label={`Open offers for ${s.number}`} onClick={() => onOpen(s)}>
                <DemoBadge />
                <strong>{s.number}</strong>
                <span>{s.origin} → {s.destination} <span className="tms-muted">· {formatDateTime(s.pickupAt)}</span></span>
                <span className="cs-demo-chips">
                  <span className="cs-demo-chip cs-demo-chip-voice"><Phone size={11} aria-hidden="true" />{c.voice} voice</span>
                  <span className="cs-demo-chip cs-demo-chip-email"><Mail size={11} aria-hidden="true" />{c.email} email</span>
                </span>
                <TmsBadge tone={st.tone}>{st.label}</TmsBadge>
                <span className="tms-muted">View offers</span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
