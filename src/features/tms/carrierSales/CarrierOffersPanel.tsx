/**
 * Click-through for a Carrier Sales load: every offer on that shipment, split by channel —
 * the voice negotiator (Aiden) and the email negotiator — with a combined best-offer summary.
 * DEMO: only the labelled demo shipments (demoOffers.ts) carry offers; a real load shows "No offers yet".
 */
import { useState } from 'react'
import { Mail, Phone } from 'lucide-react'
import { TmsBadge, TmsDrawer, TmsEmptyState, TmsTable, type ColumnDef, type TmsTone } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import {
  offerCount, summarize,
  type DemoEmailOffer, type DemoVoiceCall, type EmailOutcome, type LoadOfferStatus, type VoiceOutcome,
} from './demoOffers'
import type { OffersTarget } from './offersTarget'
import './carrierOffersPanel.css'

const VOICE_OUTCOME: Record<VoiceOutcome, { label: string; tone: TmsTone }> = {
  BOOKED: { label: 'Booked', tone: 'green' },
  ASKED_FOR_PERSON: { label: 'Asked for a person', tone: 'orange' },
  NO_DEAL: { label: 'No deal', tone: 'red' },
  HUNG_UP: { label: 'Caller hung up', tone: 'gray' },
}

const EMAIL_OUTCOME: Record<EmailOutcome, { label: string; tone: TmsTone }> = {
  BOOKED: { label: 'Booked', tone: 'green' },
  COUNTERED: { label: 'Countered', tone: 'blue' },
  DECLINED: { label: 'Declined', tone: 'red' },
  NO_DEAL: { label: 'No deal', tone: 'gray' },
}

const STATUS_LABEL: Record<LoadOfferStatus, { label: string; tone: TmsTone }> = {
  BOOKED: { label: 'Booked', tone: 'green' },
  COUNTERED: { label: 'Countered', tone: 'blue' },
  DECLINED: { label: 'Declined', tone: 'red' },
  NO_DEAL: { label: 'No deal', tone: 'gray' },
}

function duration(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

const money = (cents: number | null) => (cents == null ? '—' : formatCents(cents))

export function DemoBadge({ className }: { className?: string }) {
  return <TmsBadge tone="orange" className={`cs-demo-badge${className ? ` ${className}` : ''}`} title="Fabricated demo data, not a real load">DEMO DATA</TmsBadge>
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cs-meta">
      <span className="cs-meta-label">{label}</span>
      <span className="cs-meta-value">{children}</span>
    </div>
  )
}

function ChannelHead({ kind, title, count, sub }: { kind: 'voice' | 'email'; title: string; count: number; sub: string }) {
  const Icon = kind === 'voice' ? Phone : Mail
  return (
    <div className="cs-channel-head">
      <span className="cs-channel-icon" aria-hidden="true"><Icon size={16} /></span>
      <div className="cs-channel-titles">
        <h3 className="cs-channel-title">{title}</h3>
        <span className="cs-channel-sub">{sub}</span>
      </div>
      <span className="cs-count-chip" data-testid={`${kind}-count`} aria-label={`${count} ${kind} offers`}>{count}</span>
    </div>
  )
}

function VoiceSection({ calls, onOpen }: { calls: DemoVoiceCall[]; onOpen: (id: string) => void }) {
  const columns: Array<ColumnDef<DemoVoiceCall>> = [
    { key: 'when', header: 'When', render: (c) => <button type="button" className="cs-row-link" onClick={() => onOpen(c.id)} aria-label={`Open call from ${c.fromPhone}`}>{formatDateTime(c.startedAt)}</button> },
    { key: 'from', header: 'From', render: (c) => <span><span className="cs-mono">{c.fromPhone}</span><span className="cs-sub">{c.carrierName}</span></span> },
    { key: 'quoted', header: 'Quoted', render: (c) => <span className="cs-num">{money(c.quotedLowCents)} → {money(c.quotedHighCents)}</span> },
    { key: 'agreed', header: 'Agreed', render: (c) => (c.agreedCents == null ? <span className="tms-muted">—</span> : <strong className="cs-num cs-agreed">{money(c.agreedCents)}</strong>) },
    { key: 'length', header: 'Length', render: (c) => <span className="cs-num">{duration(c.lengthSec)}</span> },
    { key: 'outcome', header: 'Outcome', render: (c) => <TmsBadge tone={VOICE_OUTCOME[c.outcome].tone}>{VOICE_OUTCOME[c.outcome].label}</TmsBadge> },
  ]
  return (
    <section className="cs-channel cs-channel-voice" aria-label="Voice negotiator (Aiden)" data-testid="channel-voice">
      <ChannelHead kind="voice" title="Voice negotiator (Aiden)" count={calls.length} sub="Inbound carrier calls handled by the phone agent" />
      <TmsTable columns={columns} rows={calls} rowKey={(c) => c.id} empty="No calls on this load yet." />
    </section>
  )
}

function CounterTrail({ o }: { o: DemoEmailOffer }) {
  const steps = [o.offeredCents, ...o.counterCents]
  return (
    <span className="cs-trail">
      {steps.map((c, i) => (
        <span key={i} className={`cs-trail-step${i % 2 === 0 ? ' cs-trail-carrier' : ' cs-trail-ai'}`}>{money(c)}</span>
      ))}
    </span>
  )
}

function EmailSection({ offers, onOpen }: { offers: DemoEmailOffer[]; onOpen: (id: string) => void }) {
  const columns: Array<ColumnDef<DemoEmailOffer>> = [
    { key: 'carrier', header: 'Carrier', render: (o) => <button type="button" className="cs-row-link" onClick={() => onOpen(o.id)} aria-label={`Open email thread with ${o.carrierName}`}>{o.carrierName}<span className="cs-sub">MC {o.carrierMc}</span></button> },
    { key: 'from', header: 'From', render: (o) => <span className="cs-mono">{o.fromAddress}</span> },
    { key: 'received', header: 'Received', render: (o) => formatDateTime(o.receivedAt) },
    { key: 'offered', header: 'Offered', render: (o) => <span className="cs-num">{money(o.offeredCents)}</span> },
    { key: 'counters', header: 'Counter-offers', render: (o) => <CounterTrail o={o} /> },
    { key: 'outcome', header: 'Outcome', render: (o) => <TmsBadge tone={EMAIL_OUTCOME[o.outcome].tone}>{EMAIL_OUTCOME[o.outcome].label}</TmsBadge> },
  ]
  return (
    <section className="cs-channel cs-channel-email" aria-label="Email negotiator" data-testid="channel-email">
      <ChannelHead kind="email" title="Email negotiator" count={offers.length} sub="Carrier replies and AI counter-offers by email" />
      <TmsTable columns={columns} rows={offers} rowKey={(o) => o.id} empty="No emails on this load yet." />
    </section>
  )
}

function CallDrawer({ call, target, onClose }: { call: DemoVoiceCall | null; target: OffersTarget; onClose: () => void }) {
  return (
    <TmsDrawer
      open={call != null}
      onOpenChange={(o) => { if (!o) onClose() }}
      size="md"
      zIndex={80}
      className="cs-sub-drawer"
      title={call ? `Call · ${call.fromPhone}` : 'Call'}
      description={call ? call.carrierName : undefined}
      headerExtra={<DemoBadge />}
    >
      {call && (
        <div className="cs-drawer-body" data-testid="call-drawer">
          <div className="cs-meta-grid">
            <Meta label="Load">{target.number}</Meta>
            <Meta label="Outcome"><TmsBadge tone={VOICE_OUTCOME[call.outcome].tone}>{VOICE_OUTCOME[call.outcome].label}</TmsBadge></Meta>
            <Meta label="Agreed amount">{call.agreedCents == null ? '—' : <strong className="cs-agreed">{money(call.agreedCents)}</strong>}</Meta>
            <Meta label="Started">{formatDateTime(call.startedAt)}</Meta>
            <Meta label="Lane">{target.origin} → {target.destination}</Meta>
            <Meta label="Length">{duration(call.lengthSec)}</Meta>
          </div>
          <div className="cs-quote-box">
            <span className="cs-meta-label">What Aiden quoted</span>
            <span className="cs-quote-range">{money(call.quotedLowCents)} → {money(call.quotedHighCents)}</span>
            <span className="cs-sub">Carrier asked {money(call.askCents)}</span>
          </div>
          <div className="cs-note"><span className="cs-meta-label">Summary</span><p>{call.summary}</p></div>
          <div className="cs-note"><span className="cs-meta-label">Handoff</span><p>{call.handoff}</p></div>
          <h4 className="cs-drawer-h">Transcript</h4>
          <ol className="cs-transcript" aria-label="Transcript">
            {call.transcript.map((line, i) => (
              <li key={i} className={`cs-bubble-row cs-bubble-${line.speaker === 'AIDEN' ? 'aiden' : 'carrier'}`}>
                <span className="cs-bubble-who">{line.speaker}</span>
                <span className="cs-bubble">{line.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </TmsDrawer>
  )
}

function ThreadDrawer({ offer, target, onClose }: { offer: DemoEmailOffer | null; target: OffersTarget; onClose: () => void }) {
  return (
    <TmsDrawer
      open={offer != null}
      onOpenChange={(o) => { if (!o) onClose() }}
      size="md"
      zIndex={80}
      className="cs-sub-drawer"
      title={offer ? `Email thread · ${offer.carrierName}` : 'Email thread'}
      description={offer ? `MC ${offer.carrierMc} · ${offer.fromAddress}` : undefined}
      headerExtra={<DemoBadge />}
    >
      {offer && (
        <div className="cs-drawer-body" data-testid="thread-drawer">
          <div className="cs-meta-grid">
            <Meta label="Load">{target.number}</Meta>
            <Meta label="Outcome"><TmsBadge tone={EMAIL_OUTCOME[offer.outcome].tone}>{EMAIL_OUTCOME[offer.outcome].label}</TmsBadge></Meta>
            <Meta label="Opening offer">{money(offer.offeredCents)}</Meta>
            <Meta label="Agreed amount">{offer.agreedCents == null ? '—' : <strong className="cs-agreed">{money(offer.agreedCents)}</strong>}</Meta>
          </div>
          <h4 className="cs-drawer-h">Rate ladder</h4>
          <CounterTrail o={offer} />
          <h4 className="cs-drawer-h">Conversation</h4>
          <ol className="cs-thread" aria-label="Email conversation">
            {offer.messages.map((m) => (
              <li key={m.id} className={`cs-mail cs-mail-${m.from === 'AI' ? 'ai' : 'carrier'}`}>
                <div className="cs-mail-head">
                  <span className="cs-mail-who">{m.from === 'AI' ? 'AI negotiator' : offer.carrierName}</span>
                  <span className="cs-mail-time">{formatDateTime(m.at)}</span>
                </div>
                <div className="cs-mail-addr">{m.fromAddress}</div>
                <div className="cs-mail-subject">{m.subject}</div>
                <p className="cs-mail-body">{m.body}</p>
                {m.rateCents != null && <span className="cs-mail-rate" data-testid="mail-rate">{m.from === 'AI' ? 'Our counter' : 'Carrier rate'} {money(m.rateCents)}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </TmsDrawer>
  )
}

export function CarrierOffersPanel({ target, onClose }: { target: OffersTarget | null; onClose: () => void }) {
  const [callId, setCallId] = useState<string | null>(null)
  const [emailId, setEmailId] = useState<string | null>(null)
  const demo = target?.demo ?? null
  const summary = demo ? summarize(demo) : null
  const counts = demo ? offerCount(demo) : null
  const call = demo?.voiceCalls.find((c) => c.id === callId) ?? null
  const email = demo?.emailOffers.find((o) => o.id === emailId) ?? null
  const close = () => { setCallId(null); setEmailId(null); onClose() }

  return (
    <TmsDrawer
      open={target != null}
      onOpenChange={(o) => { if (!o) close() }}
      size="xl"
      className="cs-offers-drawer"
      title={target ? `Offers · ${target.number}` : 'Offers'}
      description={target ? `${target.origin} → ${target.destination}` : undefined}
      headerExtra={demo ? <DemoBadge /> : undefined}
    >
      {target && (
        <div className="cs-drawer-body" data-testid="offers-panel">
          {demo && (
            <div className="cs-demo-banner" role="note" data-testid="demo-banner">
              <DemoBadge />
              <span>Everything below is fabricated demo data for a walkthrough. It is not connected to any real call, email, carrier or load.</span>
            </div>
          )}
          <div className="cs-meta-grid">
            <Meta label="PRO">{target.number}</Meta>
            <Meta label="Lane">{target.origin} → {target.destination}</Meta>
            <Meta label="Equipment">{target.equipment}</Meta>
            <Meta label="Pickup">{formatDateTime(target.pickupAt)}</Meta>
            <Meta label="Delivery">{formatDateTime(target.deliveryAt)}</Meta>
            <Meta label="Customer rate">{money(target.customerRateCents)}</Meta>
            <Meta label="Target buy">{money(target.targetBuyCents)}</Meta>
          </div>
          {!demo || !summary || !counts ? (
            <TmsEmptyState compact title="No offers yet" message="No voice or email offers have come in on this load. Offers from Aiden and the email negotiator will show up here." />
          ) : (
            <>
              <div className="cs-summary" data-testid="offers-summary">
                <div className="cs-summary-cell">
                  <span className="cs-meta-label">Status</span>
                  <TmsBadge tone={STATUS_LABEL[summary.status].tone}>{STATUS_LABEL[summary.status].label}</TmsBadge>
                </div>
                <div className="cs-summary-cell">
                  <span className="cs-meta-label">Lowest carrier rate</span>
                  <strong className="cs-summary-rate" data-testid="lowest-rate">{money(summary.lowestCents)}</strong>
                  {summary.lowestCarrier && <span className="cs-sub">{summary.lowestCarrier} · {summary.lowestChannel === 'VOICE' ? 'voice' : 'email'}</span>}
                </div>
                <div className="cs-summary-cell">
                  <span className="cs-meta-label">Voice offers</span>
                  <strong className="cs-summary-count">{counts.voice}</strong>
                </div>
                <div className="cs-summary-cell">
                  <span className="cs-meta-label">Email offers</span>
                  <strong className="cs-summary-count">{counts.email}</strong>
                </div>
              </div>
              <VoiceSection calls={demo.voiceCalls} onOpen={setCallId} />
              <EmailSection offers={demo.emailOffers} onOpen={setEmailId} />
            </>
          )}
          <CallDrawer call={call} target={target} onClose={() => setCallId(null)} />
          <ThreadDrawer offer={email} target={target} onClose={() => setEmailId(null)} />
        </div>
      )}
    </TmsDrawer>
  )
}
