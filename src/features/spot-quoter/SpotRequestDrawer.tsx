/**
 * One spot request: the mail, the fields read from it (each with its state chip, all
 * editable), the customer, the price, and a suggested response. The e-mail side is
 * READ-ONLY: this app never sends or drafts mail. The rep edits the suggested text, copies
 * it (or opens a Gmail compose window) and sends it themselves, then marks the request
 * Sent / Won / Lost by hand.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ConvertQuoteDialog } from '@/features/quotes/components/ConvertQuoteDialog'
import { PushToDatCard } from '@/features/quotes/components/PushToDatCard'
import { RateIntelligencePanel } from '@/features/quotes/components/RateIntelligencePanel'
import { LOST_REASON_LABEL, OUTCOME_LABEL, OUTCOME_TONE } from '@/features/quotes/quoteViews'
import {
  TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsDrawer, TmsField, TmsInput, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { createCustomer, getQuote, markQuoteLost, markQuoteWon, saveQuote, sendQuote, spotAction } from '@/lib/apiClient'
import { LOST_REASONS, isOpenQuoteStatus } from '@/lib/quotes'
import { QUOTE_LINE_CODES } from '@/lib/spot/accessorials'
import type { LoadChargeInput, QuoteLostReason, QuoteRecord, SpotEquipmentCode, SpotRequestMode } from '@/types/tms'
import type { SpotRequestRecord, SpotStatusView, SpotSuggestedResponse } from '@/lib/spot/types'
import { FieldChip } from './FieldChips'
import { PricingCard } from './PricingCard'
import { formFrom, patchFromForm, rateBlock, type Form } from './spotRules'
import { copyText, gmailComposeUrl, gmailThreadUrl, mailtoUrl, quoteStops, relativeTime, spotEnds, spotOutcome } from './spotHelpers'
import { PROSPECT_STATUSES, useCustomerList } from './useCustomerIndex'
import { useSpotPricing } from './useSpotPricing'
import { useSpotRequest } from './useSpotRequests'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const EQUIPMENT: SpotEquipmentCode[] = ['VAN', 'REEFER', 'FLATBED', 'STEPDECK', 'POWER_ONLY', 'CONESTOGA', 'BOX_TRUCK', 'SPRINTER', 'OTHER']
const MODES: SpotRequestMode[] = ['FTL', 'LTL', 'PARTIAL', 'DRAYAGE', 'OTHER']
const ACCESSORIALS = [
  'LIFTGATE', 'INSIDE_DELIVERY', 'RESIDENTIAL', 'APPOINTMENT', 'LUMPER', 'DETENTION', 'LAYOVER', 'TONU', 'STOPOFF',
  'TARP', 'TEAM', 'HAZMAT', 'OVERSIZE', 'TEMP_CONTROL', 'DROP_TRAILER', 'TOLLS', 'REWEIGH',
]
const FREEMAIL = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com']

const MATCH_TEXT: Record<string, string> = {
  EMAIL: 'Exact contact',
  DOMAIN: 'Domain match — confirm',
  AMBIGUOUS: 'Ambiguous — pick one',
  NONE: 'No match',
}
const FIELD_LABEL: Record<string, string> = {
  origin: 'origin', destination: 'destination', equipment: 'equipment', pickupDate: 'pickup date',
}
const INTENT_TEXT: Record<string, string> = {
  ACCEPT: 'Looks like acceptance',
  DECLINE: 'Looks like a decline',
  COUNTER: 'Looks like a counter-offer',
  QUESTION: 'Has a question',
  OTHER: 'Customer replied',
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="tms-spot-section" data-testid={testId}>
      <h3 className="tms-spot-section-title">{title}</h3>
      {children}
    </section>
  )
}

function RequestPanel({
  request,
  status,
  onChanged,
  reload,
}: {
  request: SpotRequestRecord
  status: SpotStatusView
  onChanged: () => void
  reload: () => void
}) {
  const { user, isAdmin } = useAuth()
  const isManager = isAdmin || !!user?.groups.includes('role-MANAGER')
  const ex = request.extraction ?? null
  const [form, setForm] = useState<Form>(() => formFrom(ex))
  const [rateEdit, setRateEdit] = useState<string | null>(null)
  const [stubAck, setStubAck] = useState(false)
  const [createdQuoteId, setCreatedQuoteId] = useState<string | null>(null)
  const [response, setResponse] = useState<SpotSuggestedResponse | null>(null)
  const [subjectText, setSubjectText] = useState('')
  const [bodyText2, setBodyText2] = useState('')
  const [lostDialog, setLostDialog] = useState(false)
  const [lostReason, setLostReason] = useState('')
  const [lostCode, setLostCode] = useState<QuoteLostReason>('TOO_HIGH')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fullBody, setFullBody] = useState(false)
  const [dismissDialog, setDismissDialog] = useState(false)
  const [dismissReason, setDismissReason] = useState('')
  const [prospectName, setProspectName] = useState(ex?.customerName ?? '')
  const [convertQuote, setConvertQuote] = useState<QuoteRecord | null>(null)
  const { customers, reload: reloadCustomers } = useCustomerList()

  const pricing = useSpotPricing(ex, request.customerId)
  const ends = spotEnds(ex)
  const rateLane = ends.origin && ends.destination
    ? { originCity: ends.origin.city, originState: ends.origin.state, originZip: ends.origin.zip, destinationCity: ends.destination.city, destinationState: ends.destination.state, destinationZip: ends.destination.zip }
    : null
  const suggested = pricing.suggestion?.suggestedCents ?? null
  const rateText = rateEdit ?? (suggested != null ? String(suggested / 100) : '')
  const block = rateBlock(pricing, rateText, isManager, stubAck)

  const connection = status.connection
  const quoteId = request.quoteId ?? createdQuoteId
  const open = request.status === 'NEW' || request.status === 'NEEDS_INFO'
  const sent = request.status === 'SENT'
  const patch = patchFromForm(ex, form)
  const dirty = Object.keys(patch).length > 0
  const domain = (request.fromEmail ?? '').split('@')[1]?.toLowerCase() ?? ''
  const customer = customers.find((c) => c.id === request.customerId) ?? null
  const contactEmail = request.replyTo ?? request.fromEmail ?? ''

  const run = async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      if (done) toast.success(done)
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  const finish = () => { onChanged(); reload() }

  const saveFields = async () => {
    if (await run(() => spotAction('SPOT_UPDATE_FIELDS', { requestId: request.id, patch, expectedVersion: request.version }), 'Fields saved')) finish()
  }

  const setCustomer = async (customerId: string) => {
    if (await run(() => spotAction('SPOT_SET_CUSTOMER', { requestId: request.id, customerId, contactName: ex?.contactName ?? request.fromName ?? undefined }))) finish()
  }

  const createProspect = async () => {
    const name = prospectName.trim() || domain
    if (!name || !user) return
    const ok = await run(async () => {
      const created = await createCustomer({
        name,
        status: 'NEW',
        leadSource: 'SPOT_QUOTE',
        website: FREEMAIL.includes(domain) ? null : domain || null,
        defaultSalesRepId: user.email,
        accountOwnerIds: [user.email],
        contactName: ex?.contactName ?? request.fromName ?? null,
        contactEmail: contactEmail || null,
      })
      await spotAction('SPOT_SET_CUSTOMER', { requestId: request.id, customerId: created.id, contactName: ex?.contactName ?? request.fromName ?? undefined })
    }, 'Prospect created')
    if (ok) { reloadCustomers(); finish() }
  }

  /** Raise the quote (and its public accept link) once; the response then carries the link. */
  const createQuote = async () => {
    if (!ex || !request.customerId || block.rateCents == null) return
    const ok = await run(async () => {
      const lines: LoadChargeInput[] = [
        { side: 'CUSTOMER', code: 'LINEHAUL', label: null, calculatedBy: 'FLAT', rateCents: block.rateCents ?? 0, count: 1, isRate: true, sortOrder: 0, note: null },
        ...ex.accessorials
          .filter((a) => (QUOTE_LINE_CODES as readonly string[]).includes(a))
          .map((code, i): LoadChargeInput => ({ side: 'CUSTOMER', code, label: null, calculatedBy: 'FLAT', rateCents: 0, count: 1, isRate: false, sortOrder: i + 1, note: null })),
      ]
      const stops = quoteStops(ex)
      const saved = await saveQuote({
        side: 'SELL',
        customerId: request.customerId,
        customerName: customer?.name ?? null,
        contactName: ex.contactName ?? request.fromName ?? null,
        contactEmail,
        customerRepId: user?.email ?? null,
        stops,
        pickupAppt: stops[0]?.appt || null,
        deliveryAppt: stops[stops.length - 1]?.appt || null,
        mode: 'FTL',
        rateType: 'SPOT',
        equipmentType: ex.equipmentType,
        equipmentLengthFt: ex.lengthFt,
        commodity: ex.commodity,
        weightLbs: ex.weightLbs,
        miles: pricing.market?.answer.miles ?? null,
        lines,
        internalNotes: `From spot request ${request.id}`,
        spotRequestId: request.id,
      })
      await sendQuote({ quoteId: saved.quote.id, via: 'COPY', to: contactEmail ? [contactEmail] : undefined })
      setCreatedQuoteId(saved.quote.id)
    }, 'Quote created')
    if (ok) onChanged()
    return ok
  }

  const copyResponse = async () => {
    if (!(await copyText(bodyText2))) {
      toast.error('Could not copy; select the text and copy it by hand')
      return
    }
    toast.success('Response copied')
    try {
      await spotAction('SPOT_LOG_COPIED', { requestId: request.id, quoteId: quoteId ?? undefined })
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const markSent = async () => {
    if (await run(() => spotAction('SPOT_MARK_SENT', { requestId: request.id }), 'Marked as sent')) finish()
  }

  // The request is the rep's call and is closed first; the quote behind it (when one is still open) is
  // closed with the same reason so the lane's quote history records a loss, not a quote left pending.
  const markLost = async () => {
    const note = lostReason.trim()
    const ok = await run(async () => {
      await spotAction('SPOT_MARK_OUTCOME', { requestId: request.id, outcome: 'LOST', lostReason: note || undefined })
      const openQuote = quoteId && (!request.quoteStatus || isOpenQuoteStatus(request.quoteStatus as QuoteRecord['status']))
      if (openQuote) await markQuoteLost({ quoteId, reason: lostCode, note: note || undefined })
    }, 'Marked as lost')
    if (ok) {
      setLostDialog(false)
      finish()
    }
  }

  // Same order as Mark lost: the quote behind the request (when still open) is won first, then the request
  // reads that outcome, so the lane's win rate and the inbox agree. No shipment is built here.
  const markWon = async () => {
    const ok = await run(async () => {
      if (quoteId && (!request.quoteStatus || isOpenQuoteStatus(request.quoteStatus as QuoteRecord['status']))) await markQuoteWon({ quoteId })
      await spotAction('SPOT_MARK_OUTCOME', { requestId: request.id, outcome: 'WON' })
    }, 'Marked as won')
    if (ok) finish()
  }

  const dismiss = async () => {
    if (await run(() => spotAction('SPOT_DISMISS', { requestId: request.id, reason: dismissReason.trim() || undefined }), 'Dismissed')) {
      setDismissDialog(false)
      finish()
    }
  }

  const openConvert = async () => {
    if (!request.quoteId) return
    try {
      setConvertQuote(await getQuote(request.quoteId))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const missing = request.missingFields ?? []
  const bodyText = request.bodyText ?? ''
  const gmailUrl = connection?.mode === 'GOOGLE' ? gmailThreadUrl(connection.googleEmail, request.gmailThreadId) : null
  const canCreate = open && !quoteId && !!request.customerId && !!ex && !block.reason && missing.length === 0 && !busy
  const setF = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))
  const [toText, setToText] = useState(contactEmail)
  const [respError, setRespError] = useState<string | null>(null)
  const closed = request.status === 'DISMISSED'
  useEffect(() => {
    if (closed) return
    let live = true
    spotAction('SPOT_SUGGEST_RESPONSE', { requestId: request.id, quoteId: quoteId ?? undefined })
      .then((r) => {
        if (!live) return
        setResponse(r); setSubjectText(r.subject); setBodyText2(r.body); setToText(r.to || contactEmail); setRespError(null)
      })
      .catch((err: unknown) => { if (live) setRespError(messageOf(err)) })
    return () => { live = false }
    // contactEmail is derived from the request this panel is keyed on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, quoteId, closed])
  const chip = (key: string) => (ex ? <FieldChip fieldKey={key} extraction={ex} fieldMeta={request.fieldMeta} /> : null)

  return (
    <div data-testid="spot-detail-body">
      {error ? <TmsAlert tone="red" role="alert">{error}</TmsAlert> : null}

      <Section title="The request" testId="spot-section-request">
        <p className="tms-flush">
          <strong>{request.fromName || request.fromEmail || 'Unknown sender'}</strong>{' '}
          <span className="tms-muted">{request.fromEmail}</span>
        </p>
        <p className="tms-flush">{request.subject}</p>
        <p className="tms-flush tms-muted">Received {relativeTime(request.receivedAt)}</p>
        {gmailUrl ? <a href={gmailUrl} target="_blank" rel="noreferrer" data-testid="spot-open-gmail">Open in Gmail</a> : null}
        {request.needsAttention && request.customerReplyAt ? (
          <TmsAlert tone="orange" title="The customer replied">
            {request.replyIntent ? <TmsBadge tone="orange" data-testid="spot-reply-intent">{INTENT_TEXT[request.replyIntent]}</TmsBadge> : null}
            {(request.thread ?? []).filter((t) => t.dir === 'IN').slice(-1).map((t) => <p key={t.id} className="tms-flush">{t.snippet}</p>)}
          </TmsAlert>
        ) : null}
        {bodyText ? (
          <>
            <pre className="tms-spot-excerpt" data-testid="spot-excerpt">{fullBody ? bodyText : bodyText.slice(0, 1200)}</pre>
            {bodyText.length > 1200 && !fullBody ? (
              <TmsButton size="sm" data-testid="spot-show-full" onClick={() => setFullBody(true)}>Show full</TmsButton>
            ) : null}
          </>
        ) : null}
      </Section>

      {ex ? (
        <Section title="Extracted fields" testId="spot-section-fields">
          {missing.length > 0 ? (
            <p className="tms-field-error tms-flush" data-testid="spot-needs">
              Needs: {missing.map((k) => FIELD_LABEL[k] ?? k).join(', ')}
            </p>
          ) : null}
          <div className="tms-spot-fields">
            <TmsField label={<span className="tms-spot-field-head">Origin city {chip('origin')}</span>}>
              <TmsInput data-testid="spot-f-oCity" value={form.oCity} disabled={!open} onChange={(e) => setF('oCity', e.target.value)} />
            </TmsField>
            <TmsField label="Origin state / ZIP">
              <div style={{ display: 'flex', gap: 8 }}>
                <TmsInput data-testid="spot-f-oState" aria-label="Origin state" value={form.oState} disabled={!open} onChange={(e) => setF('oState', e.target.value)} />
                <TmsInput data-testid="spot-f-oZip" aria-label="Origin ZIP" value={form.oZip} disabled={!open} onChange={(e) => setF('oZip', e.target.value)} />
              </div>
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Destination city {chip('destination')}</span>}>
              <TmsInput data-testid="spot-f-dCity" value={form.dCity} disabled={!open} onChange={(e) => setF('dCity', e.target.value)} />
            </TmsField>
            <TmsField label="Destination state / ZIP">
              <div style={{ display: 'flex', gap: 8 }}>
                <TmsInput data-testid="spot-f-dState" aria-label="Destination state" value={form.dState} disabled={!open} onChange={(e) => setF('dState', e.target.value)} />
                <TmsInput data-testid="spot-f-dZip" aria-label="Destination ZIP" value={form.dZip} disabled={!open} onChange={(e) => setF('dZip', e.target.value)} />
              </div>
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Pickup date {chip('pickupDate')}</span>}>
              <TmsInput data-testid="spot-f-pickupDate" type="date" value={form.pickupDate} disabled={!open} onChange={(e) => setF('pickupDate', e.target.value)} />
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Delivery date {chip('deliveryDate')}</span>}>
              <TmsInput data-testid="spot-f-deliveryDate" type="date" value={form.deliveryDate} disabled={!open} onChange={(e) => setF('deliveryDate', e.target.value)} />
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Equipment {chip('equipment')}</span>}>
              <TmsSelect
                data-testid="spot-f-equipment"
                value={form.equipmentType}
                disabled={!open}
                placeholder="Choose…"
                options={EQUIPMENT.map((v) => ({ value: v, label: v.replace('_', ' ').toLowerCase() }))}
                onChange={(e) => setF('equipmentType', e.target.value)}
              />
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Length (ft) {chip('lengthFt')}</span>}>
              <TmsInput data-testid="spot-f-lengthFt" inputMode="numeric" value={form.lengthFt} disabled={!open} onChange={(e) => setF('lengthFt', e.target.value)} />
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Weight (lbs) {chip('weightLbs')}</span>}>
              <TmsInput data-testid="spot-f-weightLbs" inputMode="numeric" value={form.weightLbs} disabled={!open} onChange={(e) => setF('weightLbs', e.target.value)} />
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Commodity {chip('commodity')}</span>}>
              <TmsInput data-testid="spot-f-commodity" value={form.commodity} disabled={!open} onChange={(e) => setF('commodity', e.target.value)} />
            </TmsField>
            <TmsField label={<span className="tms-spot-field-head">Mode {chip('mode')}</span>}>
              <TmsSelect
                data-testid="spot-f-mode"
                value={form.mode}
                disabled={!open}
                placeholder="Choose…"
                options={MODES.map((v) => ({ value: v, label: v }))}
                onChange={(e) => setF('mode', e.target.value)}
              />
            </TmsField>
          </div>
          <TmsField label={<span className="tms-spot-field-head">Accessorials {chip('accessorials')}</span>}>
            <div className="tms-spot-accessorials">
              {[...ACCESSORIALS, ...form.accessorials.filter((a) => !ACCESSORIALS.includes(a))].map((code) => (
                <label key={code} className="tms-check-row">
                  <input
                    type="checkbox"
                    data-testid={`spot-acc-${code}`}
                    checked={form.accessorials.includes(code)}
                    disabled={!open}
                    onChange={(e) => setF('accessorials', e.target.checked ? [...form.accessorials, code] : form.accessorials.filter((a) => a !== code))}
                  />
                  <span>{code.replace('ACCESSORIAL:', '').replaceAll('_', ' ').toLowerCase()}</span>
                </label>
              ))}
            </div>
          </TmsField>
          {open ? (
            <div className="tms-spot-actions">
              <TmsButton data-testid="spot-save-fields" disabled={!dirty || busy} onClick={() => void saveFields()}>Save fields</TmsButton>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title="Customer" testId="spot-section-customer">
        <p className="tms-flush">
          <TmsBadge tone={request.matchHow === 'EMAIL' ? 'green' : 'gray'} data-testid="spot-match">
            {MATCH_TEXT[request.matchHow ?? 'NONE']}
          </TmsBadge>{' '}
          {customer ? (
            <strong data-testid="spot-customer-name">
              {customer.name}{' '}
              <TmsBadge tone="blue">{customer.status && PROSPECT_STATUSES[customer.status] ? 'Prospect' : 'Customer'}</TmsBadge>
            </strong>
          ) : null}
        </p>
        {open ? (
          <>
            <TmsSelect
              data-testid="spot-customer-select"
              aria-label="Customer"
              value={request.customerId ?? ''}
              placeholder="Pick a customer…"
              disabled={busy}
              options={[
                ...(request.matchCandidates ?? []).map((c) => ({ value: c.customerId, label: `${c.name ?? c.customerId} (suggested)` })),
                ...customers.filter((c) => !(request.matchCandidates ?? []).some((m) => m.customerId === c.id)).map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(e) => e.target.value && void setCustomer(e.target.value)}
            />
            {!request.customerId ? (
              <div className="tms-spot-actions">
                <TmsInput data-testid="spot-prospect-name" aria-label="Prospect name" value={prospectName} placeholder={domain || 'Company name'} onChange={(e) => setProspectName(e.target.value)} />
                <TmsButton data-testid="spot-create-prospect" disabled={busy || !(prospectName.trim() || domain)} onClick={() => void createProspect()}>
                  Create prospect
                </TmsButton>
                {domain && !FREEMAIL.includes(domain) ? <span className="tms-muted">Domain {domain} will be linked to it.</span> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section title="Pricing" testId="spot-section-pricing">
        <PricingCard pricing={pricing} rateText={rateText} onRateText={setRateEdit} stubAck={stubAck} onStubAck={setStubAck} block={block} disabled={!open} />
      </Section>

      <div data-testid="spot-section-intel">
        <RateIntelligencePanel
          lane={rateLane}
          equipmentType={ex?.equipmentType ?? null}
          customerId={request.customerId}
          pickupDate={ex?.pickupDate ?? null}
          excludeQuoteId={quoteId}
          market={pricing.market}
          marketLoading={pricing.loading}
          marketError={pricing.error}
        />
      </div>

      <div data-testid="spot-section-push-dat">
        <PushToDatCard
          quoteId={quoteId}
          spotRequestId={request.id}
          load={{
            originCity: ends.origin?.city, originState: ends.origin?.state,
            destinationCity: ends.destination?.city, destinationState: ends.destination?.state,
            equipmentType: ex?.equipmentType ?? null, pickupDate: ex?.pickupDate ?? null, weightLbs: ex?.weightLbs ?? null,
          }}
          disabled={!(open || sent) || !rateLane || !ex?.equipmentType}
          disabledReason={!(open || sent) ? 'This request is closed.' : 'Needs a pickup, a delivery and an equipment type.'}
        />
      </div>

      <Section title="Suggested response" testId="spot-section-reply">
        <p className="tms-muted tms-flush" data-testid="spot-readonly-note">
          Read-only: BCAT Ops never sends or drafts mail. Edit the text, copy it and send it yourself.
        </p>
        {respError ? <p className="tms-field-error tms-flush">{respError}</p> : null}
        {response ? (
          <>
            {!response.hasLink ? <p className="tms-muted tms-flush">No accept link yet — create the quote to add one.</p> : null}
            <TmsField label="To">
              <TmsInput data-testid="spot-resp-to" value={toText} onChange={(e) => setToText(e.target.value)} />
            </TmsField>
            <TmsField label="Subject">
              <TmsInput data-testid="spot-resp-subject" value={subjectText} onChange={(e) => setSubjectText(e.target.value)} />
            </TmsField>
            <TmsField label="Response">
              <TmsTextarea data-testid="spot-resp-body" rows={10} value={bodyText2} onChange={(e) => setBodyText2(e.target.value)} />
            </TmsField>
            <div className="tms-spot-actions">
              <TmsButton variant="primary" data-testid="spot-copy" onClick={() => void copyResponse()}>Copy response</TmsButton>
              <a className="tms-btn tms-btn-secondary" data-testid="spot-open-compose" href={gmailComposeUrl(toText, subjectText, bodyText2)} target="_blank" rel="noreferrer">Open in Gmail</a>
              <a data-testid="spot-open-mailto" href={mailtoUrl(toText, subjectText, bodyText2)}>Open in mail app</a>
            </div>
          </>
        ) : !respError ? <p className="tms-muted tms-flush">Preparing the suggested response…</p> : null}
      </Section>

      <Section title="Actions" testId="spot-section-actions">
        {open ? (
          <div className="tms-spot-actions">
            <TmsButton variant="primary" data-testid="spot-create-quote" disabled={!canCreate} title={block.reason ?? (request.customerId ? undefined : 'Pick or create the customer first')} onClick={() => void createQuote()}>
              Create quote
            </TmsButton>
            <TmsButton data-testid="spot-mark-sent" disabled={busy} onClick={() => void markSent()}>Mark sent</TmsButton>
            <TmsButton variant="destructive" data-testid="spot-dismiss" disabled={busy} onClick={() => setDismissDialog(true)}>Dismiss</TmsButton>
          </div>
        ) : null}
        {!request.customerId && open ? <p className="tms-muted tms-flush">Pick or create the customer to quote this.</p> : null}
        {block.reason && open && request.customerId && !quoteId ? <p className="tms-muted tms-flush" data-testid="spot-create-reason">{block.reason}</p> : null}

        {sent ? (
          <div className="tms-spot-actions">
            {request.sentAt ? <p className="tms-flush tms-muted">Marked sent {relativeTime(request.sentAt)}.</p> : null}
            {quoteId ? <TmsButton data-testid="spot-convert" disabled={busy} onClick={() => void openConvert()}>Convert to shipment</TmsButton> : null}
            {quoteId ? <TmsButton data-testid="spot-mark-won" disabled={busy} onClick={() => void markWon()}>Mark won</TmsButton> : null}
            <TmsButton variant="destructive" data-testid="spot-mark-lost" disabled={busy} onClick={() => setLostDialog(true)}>Mark lost</TmsButton>
          </div>
        ) : null}
        {request.status === 'WON' && request.shipmentNumber ? <p className="tms-flush">Booked as shipment {request.shipmentNumber}.</p> : null}
        {spotOutcome(request.status) ? (
          <p className="tms-flush" data-testid="spot-request-outcome">
            Outcome: <TmsBadge tone={OUTCOME_TONE[spotOutcome(request.status)!]}>{OUTCOME_LABEL[spotOutcome(request.status)!]}</TmsBadge>
          </p>
        ) : null}
        {sent && !quoteId ? <p className="tms-flush tms-muted">Create the quote to mark this won.</p> : null}
        {quoteId ? <p className="tms-flush tms-muted">Quote {request.quoteNumber ?? quoteId}{request.quoteStatus ? ` · ${request.quoteStatus}` : ''}</p> : null}
      </Section>

      <TmsDialog
        open={lostDialog}
        onOpenChange={setLostDialog}
        title="Mark this request lost?"
        footer={
          <>
            <TmsButton onClick={() => setLostDialog(false)}>Cancel</TmsButton>
            <TmsButton variant="destructive" data-testid="spot-lost-confirm" disabled={busy} onClick={() => void markLost()}>Mark lost</TmsButton>
          </>
        }
      >
        <TmsField label="Why we did not get it">
          <TmsSelect
            data-testid="spot-lost-code"
            value={lostCode}
            onChange={(e) => setLostCode(e.target.value as QuoteLostReason)}
            options={LOST_REASONS.map((value) => ({ value, label: LOST_REASON_LABEL[value] }))}
          />
        </TmsField>
        <TmsField label="Note (optional)">
          <TmsInput data-testid="spot-lost-reason" maxLength={200} value={lostReason} onChange={(e) => setLostReason(e.target.value)} />
        </TmsField>
      </TmsDialog>

      <TmsDialog
        open={dismissDialog}
        onOpenChange={setDismissDialog}
        title="Dismiss this request?"
        footer={
          <>
            <TmsButton onClick={() => setDismissDialog(false)}>Cancel</TmsButton>
            <TmsButton variant="destructive" data-testid="spot-dismiss-confirm" disabled={busy} onClick={() => void dismiss()}>Dismiss</TmsButton>
          </>
        }
      >
        <TmsField label="Reason (optional)">
          <TmsInput data-testid="spot-dismiss-reason" value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} />
        </TmsField>
      </TmsDialog>

      {convertQuote ? (
        <ConvertQuoteDialog
          quote={convertQuote}
          open
          onOpenChange={(o) => { if (!o) setConvertQuote(null) }}
          onDone={() => {
            setConvertQuote(null)
            void run(() => spotAction('SPOT_MARK_OUTCOME', { requestId: request.id, outcome: 'WON' })).then(finish)
          }}
        />
      ) : null}
    </div>
  )
}

export function SpotRequestDrawer({
  requestId,
  status,
  onClose,
  onChanged,
}: {
  requestId: string | null
  status: SpotStatusView
  onClose: () => void
  onChanged: () => void
}) {
  const { result, loading, error, refresh } = useSpotRequest(requestId)
  return (
    <TmsDrawer
      open={requestId != null}
      onOpenChange={(o) => { if (!o) onClose() }}
      title={result?.request.subject || 'Spot request'}
      size="xl"
      className="tms-spot-detail"
    >
      <div data-testid="spot-detail">
        {loading ? <p className="tms-muted">Loading…</p> : null}
        {error ? <TmsAlert tone="red">{error}</TmsAlert> : null}
        {result ? (
          <RequestPanel
            key={`${result.request.id}:${result.request.version}`}
            request={result.request}
            status={status}
            onChanged={onChanged}
            reload={refresh}
          />
        ) : null}
      </div>
    </TmsDrawer>
  )
}
