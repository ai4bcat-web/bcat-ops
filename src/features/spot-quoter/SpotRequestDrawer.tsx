/**
 * One spot request: the mail, the fields read from it (each with its state chip, all
 * editable), the customer, the price, the reply, and the actions. Nothing here sends mail:
 * "Create quote & Gmail draft" leaves a draft in the rep's own Gmail and the rep presses
 * Send there. `Send now` exists for convenience and asks first, showing the text Gmail
 * holds at that moment.
 */
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ConvertQuoteDialog } from '@/features/quotes/components/ConvertQuoteDialog'
import {
  TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsDrawer, TmsField, TmsInput, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { createCustomer, getQuote, saveQuote, sendQuote, spotAction } from '@/lib/apiClient'
import { QUOTE_LINE_CODES } from '@/lib/spot/accessorials'
import { renderSpotReply } from '@/lib/spot/replyTemplate'
import type { LoadChargeInput, QuoteRecord, SpotEquipmentCode, SpotRequestMode } from '@/types/tms'
import type { SpotRequestRecord, SpotStatusView } from '@/lib/spot/types'
import { FieldChip } from './FieldChips'
import { PricingCard } from './PricingCard'
import { formFrom, patchFromForm, rateBlock, type Form } from './spotRules'
import { gmailThreadUrl, money, quoteStops, relativeTime, spotEnds } from './spotHelpers'
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
  draft,
  status,
  onChanged,
  reload,
}: {
  request: SpotRequestRecord
  draft: { to: string; subject: string; text: string } | null
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
  const [intro, setIntro] = useState('')
  const [outro, setOutro] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fullBody, setFullBody] = useState(false)
  const [sendDialog, setSendDialog] = useState(false)
  const [dismissDialog, setDismissDialog] = useState(false)
  const [dismissReason, setDismissReason] = useState('')
  const [prospectName, setProspectName] = useState(ex?.customerName ?? '')
  const [convertQuote, setConvertQuote] = useState<QuoteRecord | null>(null)
  const { customers, reload: reloadCustomers } = useCustomerList()

  const pricing = useSpotPricing(ex, request.customerId)
  const suggested = pricing.suggestion?.suggestedCents ?? null
  const rateText = rateEdit ?? (suggested != null ? String(suggested / 100) : '')
  const block = rateBlock(pricing, rateText, isManager, stubAck)

  const connection = status.connection
  const open = request.status === 'NEW' || request.status === 'NEEDS_INFO'
  const drafted = request.status === 'DRAFTED'
  const patch = patchFromForm(ex, form)
  const dirty = Object.keys(patch).length > 0
  const domain = (request.fromEmail ?? '').split('@')[1]?.toLowerCase() ?? ''
  const customer = customers.find((c) => c.id === request.customerId) ?? null
  const contactEmail = request.replyTo ?? request.fromEmail ?? ''
  const { origin, destination } = spotEnds(ex)

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

  /** The quote exists once; a retry after a failed draft goes straight to the draft. */
  const createQuoteAndMaybeDraft = async (withDraft: boolean) => {
    if (!ex || !request.customerId || block.rateCents == null) return
    const ok = await run(async () => {
      let quoteId = request.quoteId ?? null
      if (!quoteId) {
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
        quoteId = saved.quote.id
        await sendQuote({ quoteId, via: 'COPY', to: contactEmail ? [contactEmail] : undefined })
      }
      if (withDraft) await spotAction('SPOT_CREATE_DRAFT', { requestId: request.id, quoteId, intro: intro || undefined, outro: outro || undefined })
    }, withDraft ? 'Quote created — draft is in your Gmail' : 'Quote created')
    // The quote may exist even when the draft failed: reload so the page says so.
    finish()
    return ok
  }

  const updateDraft = async () => {
    if (!request.quoteId) return
    if (await run(() => spotAction('SPOT_CREATE_DRAFT', { requestId: request.id, quoteId: request.quoteId as string, intro: intro || undefined, outro: outro || undefined }), 'Draft updated')) finish()
  }

  const sendNow = async () => {
    if (await run(() => spotAction('SPOT_SEND_DRAFT', { requestId: request.id, confirm: true }), 'Sent from your Gmail')) {
      setSendDialog(false)
      finish()
    }
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
  const draftUrl = connection?.mode === 'GOOGLE' && request.draftMessageId
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(connection.googleEmail ?? '')}#drafts?compose=${encodeURIComponent(request.draftMessageId)}`
    : null
  const preview =
    ex && block.rateCents != null && origin && destination && ex.equipmentType
      ? renderSpotReply({
          rateCents: block.rateCents,
          origin: { city: origin.city, state: origin.state },
          destination: { city: destination.city, state: destination.state },
          equipmentType: ex.equipmentType,
          lengthFt: ex.lengthFt,
          pickupDate: ex.pickupDate,
          expiresAt: null,
          link: '[accept link is added when the quote is created]',
          intro,
          outro,
          signature: connection?.settings?.signature ?? '',
        })
      : null
  const canCreate = open && !!request.customerId && !!ex && !block.reason && missing.length === 0 && !busy
  const setF = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))
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
        {open || drafted ? (
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

      <Section title="Reply" testId="spot-section-reply">
        {drafted && draft ? (
          <>
            <p className="tms-flush tms-muted">Draft in your Gmail — To {draft.to}, “{draft.subject}”</p>
            <pre className="tms-spot-reply" data-testid="spot-draft-text">{draft.text}</pre>
          </>
        ) : (
          <>
            <TmsField label="Intro (optional, up to 600 characters)">
              <TmsTextarea data-testid="spot-intro" rows={2} maxLength={600} value={intro} disabled={!open && !drafted} onChange={(e) => setIntro(e.target.value)} />
            </TmsField>
            <TmsField label="Closing (optional, up to 600 characters)">
              <TmsTextarea data-testid="spot-outro" rows={2} maxLength={600} value={outro} disabled={!open && !drafted} onChange={(e) => setOutro(e.target.value)} />
            </TmsField>
            {preview ? <pre className="tms-spot-reply" data-testid="spot-reply-preview">{preview}</pre> : <p className="tms-muted tms-flush">The reply preview appears once the lane, equipment and rate are set.</p>}
          </>
        )}
      </Section>

      <Section title="Actions" testId="spot-section-actions">
        {request.autoDecision ? (
          <TmsAlert tone={request.autoDecision.decision === 'SENT' ? 'green' : 'blue'} title={request.autoDecision.decision === 'SENT' ? `Sent automatically ${relativeTime(request.autoDecision.at)}` : `Auto-send: ${request.autoDecision.decision.toLowerCase().replace('_', ' ')}`}>
            <span data-testid="spot-auto-decision">{request.autoDecision.reasons.join(', ') || 'All gates passed.'}{request.autoDecision.error ? ` — ${request.autoDecision.error}` : ''}</span>
          </TmsAlert>
        ) : null}
        {request.quoteId && open ? (
          <p className="tms-field-error tms-flush" data-testid="spot-draft-failed">
            Quote {request.quoteNumber ?? request.quoteId} was created, but the Gmail draft was not.
          </p>
        ) : null}
        {open ? (
          <div className="tms-spot-actions">
            <TmsButton variant="primary" data-testid="spot-create-draft" disabled={!canCreate} title={block.reason ?? (request.customerId ? undefined : 'Pick or create the customer first')} onClick={() => void createQuoteAndMaybeDraft(true)}>
              {request.quoteId ? 'Retry Gmail draft' : 'Create quote & Gmail draft'}
            </TmsButton>
            {!request.quoteId ? (
              <TmsButton data-testid="spot-create-quote" disabled={!canCreate} title={block.reason ?? undefined} onClick={() => void createQuoteAndMaybeDraft(false)}>
                Create quote only
              </TmsButton>
            ) : null}
            <TmsButton variant="destructive" data-testid="spot-dismiss" disabled={busy} onClick={() => setDismissDialog(true)}>Dismiss</TmsButton>
          </div>
        ) : null}
        {!request.customerId && open ? <p className="tms-muted tms-flush">Pick or create the customer to quote this.</p> : null}
        {block.reason && open && request.customerId ? <p className="tms-muted tms-flush" data-testid="spot-create-reason">{block.reason}</p> : null}

        {drafted ? (
          <div className="tms-spot-actions">
            <p className="tms-flush">Draft ready in your Gmail — nothing has been sent.</p>
            {draftUrl ? <a href={draftUrl} target="_blank" rel="noreferrer" data-testid="spot-open-draft">Open draft in Gmail</a> : null}
            <TmsButton data-testid="spot-update-draft" disabled={busy} onClick={() => void updateDraft()}>Update draft</TmsButton>
            <span title={status.devStack ? 'Sending is disabled on the dev stack. Send the draft from Gmail.' : undefined}>
              <TmsButton data-testid="spot-send-now" disabled={busy || status.devStack || !draft} onClick={() => setSendDialog(true)}>Send now</TmsButton>
            </span>
            <TmsButton variant="destructive" data-testid="spot-dismiss" disabled={busy} onClick={() => setDismissDialog(true)}>Dismiss</TmsButton>
          </div>
        ) : null}

        {request.status === 'SENT' || request.status === 'AUTO_PENDING' || (drafted && request.customerReplyAt) ? (
          request.sentAt ? <p className="tms-flush tms-muted">Sent {relativeTime(request.sentAt)}{request.sentVia === 'AUTO' ? ' automatically' : ''}.</p> : null
        ) : null}
        {request.quoteId && (request.status === 'SENT' || drafted) ? (
          <TmsButton data-testid="spot-convert" disabled={busy} onClick={() => void openConvert()}>Convert to shipment</TmsButton>
        ) : null}
        {request.status === 'WON' && request.shipmentNumber ? <p className="tms-flush">Booked as shipment {request.shipmentNumber}.</p> : null}
        {request.quoteId ? <p className="tms-flush tms-muted">Quote {request.quoteNumber ?? request.quoteId}{request.quoteStatus ? ` · ${request.quoteStatus}` : ''}{suggested != null && open ? ` · suggested ${money(suggested)}` : ''}</p> : null}
      </Section>

      <TmsDialog
        open={sendDialog}
        onOpenChange={setSendDialog}
        title="Send this e-mail now?"
        description="This sends the e-mail from your Gmail now."
        footer={
          <>
            <TmsButton onClick={() => setSendDialog(false)}>Cancel</TmsButton>
            <TmsButton variant="primary" data-testid="spot-send-confirm" disabled={busy} onClick={() => void sendNow()}>Send</TmsButton>
          </>
        }
      >
        {draft ? (
          <div data-testid="spot-send-preview">
            <p className="tms-flush"><strong>To:</strong> {draft.to}</p>
            <p className="tms-flush"><strong>Subject:</strong> {draft.subject}</p>
            <pre className="tms-spot-reply">{draft.text.slice(0, 400)}</pre>
          </div>
        ) : null}
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
            void run(() => spotAction('SPOT_MARK_OUTCOME', { requestId: request.id })).then(finish)
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
            draft={result.draft}
            status={status}
            onChanged={onChanged}
            reload={refresh}
          />
        ) : null}
      </div>
    </TmsDrawer>
  )
}
