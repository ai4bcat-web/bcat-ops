/**
 * Putting a number in front of somebody — the one act on the sell side that cannot be
 * taken back, because a link goes out with it.
 *
 * Three things have to be true before Send is offered: we know who it is going to, the
 * body says what we think it says, and every pricing warning has been read. The
 * warnings come from `priceQuoteLines`, the same function `SEND_QUOTE` re-runs
 * server-side, so this form and the Lambda cannot disagree about what is wrong with the
 * price. Each is acknowledged by its machine `key`, which is what the action is told.
 *
 * SES is denied outside production. A send that comes back `sent: false` is not an
 * error and is never drawn as one: the link was minted, the thread was written, and the
 * only delivery left is a human copying the body. The NOT_SENT banner is that delivery
 * — on dev it is how a quote actually reaches a customer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, Link2, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'
import {
  counterQuote, getTmsSettings, graphqlErrorText, listCustomers, listDivisions, sendQuote,
  type QuoteSendResult,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { priceQuoteLines, quoteState, type QuotePricingWarning } from '@/lib/quotes'
import { renderCounterEmail, renderQuoteEmail, quoteRecipients } from '@/lib/quoteNotices'
import { quoteLinkUrl } from '../quoteViews'
import type { CustomerRecord, Division, QuoteRecord, TmsSettings } from '@/types/tms'

const LINK_PLACEHOLDER = 'https://…/quote/<the link is minted when you send>'

const PRE_STYLE: React.CSSProperties = {
  maxHeight: 224, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, margin: 0,
  borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)',
  background: 'var(--tms-card)', padding: 8,
}

const CODE_STYLE: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12,
  borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)',
  background: 'var(--tms-card)', padding: '4px 8px',
}

const WARN_BOX: React.CSSProperties = {
  display: 'grid', gap: 8, borderRadius: 'var(--tms-radius)',
  border: '1px solid var(--tms-badge-orange)', background: 'rgba(255,136,10,0.12)', padding: 8,
}

export function SendQuoteDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [customer, setCustomer] = useState<CustomerRecord | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  const [message, setMessage] = useState('')
  const [acked, setAcked] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<QuoteSendResult | null>(null)

  const customerId = quote.customerId ?? null

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    Promise.all([getTmsSettings(), listCustomers(), listDivisions()])
      .then(([tmsSettings, customers, divisionRows]) => {
        setSettings(tmsSettings)
        setCustomer(customers.find((row) => row.id === customerId) ?? null)
        setDivisions(divisionRows)
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [customerId])

  useEffect(() => { load() }, [load])

  const state = quoteState(quote, new Date().toISOString())
  const countering = quote.status === 'RECEIVED_COUNTER'

  const brokerName =
    divisions.find((d) => d.key === quote.divisionKey)?.name
    ?? divisions.find((d) => d.active)?.name
    ?? 'BCAT'

  const recipients = useMemo(
    () => quoteRecipients(quote, customer?.contacts ?? null),
    [quote, customer],
  )

  const warnings: QuotePricingWarning[] = useMemo(() => {
    const lines = quote.lines ?? []
    if (lines.length === 0) return []
    const pricing = customer?.pricingDefaults ?? null
    return priceQuoteLines(
      lines,
      { miles: quote.miles ?? null, weightLbs: quote.weightLbs ?? null },
      pricing,
      settings?.marginFloorBps ?? null,
      pricing,
    ).warnings
  }, [quote, customer, settings])

  const preview = useMemo(() => {
    const input = {
      quote,
      link: quoteLinkUrl(quote.linkToken, window.location.origin) ?? LINK_PLACEHOLDER,
      brokerName,
      template: countering ? settings?.counterEmailTemplate : settings?.quoteEmailTemplate,
      termsText: settings?.quoteTermsText ?? null,
    }
    return countering ? renderCounterEmail(input) : renderQuoteEmail(input)
  }, [quote, brokerName, countering, settings])

  const unacknowledged = warnings.filter((warning) => acked.includes(warning.key) === false)
  const disabled = sending || loading
  const blocked = recipients.length === 0 || unacknowledged.length > 0 || state.canSend === false

  const run = (via: 'EMAIL' | 'COPY') => {
    setSending(true)
    setError(null)
    const input = {
      quoteId: quote.id,
      expectedVersion: quote.version,
      message: message.trim() || undefined,
      via,
      acknowledgeWarnings: warnings.map((warning) => warning.key),
    }
    const answer = countering ? counterQuote(input) : sendQuote(input)
    answer
      .then((sendResult) => {
        setResult(sendResult)
        if (sendResult.sent) toast.success(`Quote ${quote.id} sent to ${recipients.join(', ')}`)
        else toast.warning('Nothing was e-mailed — copy the link below')
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setSending(false))
  }

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text)
      .then(() => toast.success(`${what} copied`))
      .catch(() => toast.error(`Could not copy the ${what.toLowerCase()}`))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      className="tms-dialog-wide"
      title={`${countering ? 'Counter' : 'Send'} quote ${quote.id} — ${formatCents(quote.amountCents)}`}
      footer={
        result ? (
          <TmsButton variant="primary" onClick={onDone}>Done</TmsButton>
        ) : (
          <>
            <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>Cancel</TmsButton>
            <TmsButton
              aria-label="Mint a link without e-mailing"
              disabled={disabled || state.canSend === false}
              onClick={() => run('COPY')}
            >
              <Link2 size={14} /> Link only
            </TmsButton>
            <TmsButton variant="primary" aria-label="Send the quote" disabled={disabled || blocked} onClick={() => run('EMAIL')}>
              <Send size={14} /> {sending ? 'Sending…' : 'Send'}
            </TmsButton>
          </>
        )
      }
    >
      {loading && (
        <p className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <Loader2 size={14} /> Reading the customer and the templates…
        </p>
      )}

      {loading === false && result === null && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <div className="tms-field-label">Going to</div>
            <p style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {recipients.length > 0
                ? recipients.map((email) => <TmsBadge key={email} tone="blue">{email}</TmsBadge>)
                : <span className="tms-field-error">Nobody — this quote has no contact e-mail and the customer has no sales contact.</span>}
            </p>
          </div>

          <TmsField label="A line of your own (optional)" htmlFor="send-quote-message">
            <TmsTextarea
              id="send-quote-message"
              rows={2}
              value={message}
              disabled={disabled}
              placeholder="anything the template does not already say"
              onChange={(e) => setMessage(e.target.value)}
            />
          </TmsField>

          <div>
            <div className="tms-field-label">What they will read — {preview.subject}</div>
            <pre style={PRE_STYLE}>{preview.body}</pre>
            <p className="tms-muted" style={{ marginTop: 4, fontSize: 12 }}>
              The link above is minted by the send itself; this preview shows where it lands.
            </p>
          </div>

          {warnings.length > 0 && (
            <div style={WARN_BOX}>
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, fontWeight: 600, margin: 0 }}>
                <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0, color: 'var(--tms-badge-orange)' }} />
                Read these before the number goes out; the acknowledgement is kept on the quote.
              </p>
              {warnings.map((warning) => (
                <label key={warning.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    aria-label={`Acknowledge ${warning.key}`}
                    checked={acked.includes(warning.key)}
                    disabled={disabled}
                    onChange={(e) => setAcked((prev) => (
                      e.target.checked ? [...prev, warning.key] : prev.filter((key) => key !== warning.key)
                    ))}
                  />
                  <span>
                    {warning.message}
                    {warning.adminOnly && <TmsBadge tone="gray">owner / admin</TmsBadge>}
                  </span>
                </label>
              ))}
            </div>
          )}

          {state.canSend === false && (
            <p className="tms-field-error">
              This quote is not on a rung that can be sent — it is {quote.status.toLowerCase().replace('_', ' ')}.
            </p>
          )}

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      )}

      {result && (
        <div style={{ display: 'grid', gap: 12 }}>
          {result.sent ? (
            <p style={{ fontSize: 13 }}>
              Sent to {recipients.join(', ')}. The link is live until the quote expires.
            </p>
          ) : (
            <div style={WARN_BOX}>
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, fontWeight: 600, margin: 0 }}>
                <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0, color: 'var(--tms-badge-orange)' }} />
                Nothing was e-mailed. The quote is sent and the link is live — send it by hand.
              </p>
              <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
                This is the dev path: outbound mail is denied outside production, so the copy below is the
                delivery. The quote row already says it went out, because the link works.
              </p>
            </div>
          )}

          {result.link && (
            <div>
              <div className="tms-field-label">The link</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={CODE_STYLE}>{result.link}</code>
                <TmsButton size="sm" aria-label="Copy quote link" onClick={() => copy(result.link ?? '', 'Link')}>
                  <Link2 size={13} /> Copy
                </TmsButton>
              </div>
            </div>
          )}

          <div>
            <div className="tms-field-label">{result.subject}</div>
            <pre style={PRE_STYLE}>{result.body}</pre>
            <TmsButton size="sm" style={{ marginTop: 4 }} aria-label="Copy e-mail body" onClick={() => copy(result.body, 'E-mail body')}>
              <Copy size={13} /> Copy the body
            </TmsButton>
          </div>
        </div>
      )}
    </TmsDialog>
  )
}
