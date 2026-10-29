/**
 * Our answer to their number.
 *
 * On the sell side a counter is not a new price typed over the old one: the customer
 * countered a total, and the accessorials on the quote did not change because of it.
 * `absorbCounter` puts the difference into the line haul and leaves the rest alone, and
 * the preview here is that same function — so what the dialog shows is what the Lambda
 * will store. A counter that would drive the line haul negative is refused by the lib
 * before the action is ever called.
 *
 * On the buy side there are no lines to spread: an offer is one number, and the counter
 * replaces it.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Copy, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { counterOffer, counterQuote, graphqlErrorText, type QuoteSendResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { absorbCounter, humanChargeCode } from '@/lib/quotes'
import { priceCharges } from '@/lib/shipmentCharges'
import { theirNumberCents } from '../quoteViews'
import type { LoadChargeInput, QuoteRecord } from '@/types/tms'

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

export function CounterDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const theirs = theirNumberCents(quote)
  const [amountCents, setAmountCents] = useState<number | null>(quote.amountCents || null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<QuoteSendResult | null>(null)

  const sell = quote.side === 'SELL'
  const lines = useMemo(() => quote.lines ?? [], [quote])

  // The preview is the refusal too: `absorbCounter` throws when a number cannot be
  // spread over these lines, and that sentence is the one the Lambda would answer with.
  const absorbed = useMemo((): { lines: LoadChargeInput[] } | { error: string } | null => {
    if (sell === false || amountCents == null || lines.length === 0) return null
    try {
      return { lines: absorbCounter(lines, amountCents, { miles: quote.miles ?? null, weightLbs: quote.weightLbs ?? null }) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'That counter cannot be spread over these lines' }
    }
  }, [sell, amountCents, lines, quote])

  const absorbError = absorbed && 'error' in absorbed ? absorbed.error : null
  // `priceCharges` answers in the order it was given, so the label on the draft line and
  // the amount the pricer worked out belong to the same row by index.
  const previewLines = absorbed && 'lines' in absorbed
    ? priceCharges(absorbed.lines, { miles: quote.miles ?? null, weightLbs: quote.weightLbs ?? null })
      .map((priced, index) => ({ priced, draft: absorbed.lines[index] }))
      .filter((row) => row.priced.side === 'CUSTOMER')
    : []

  const submit = () => {
    if (amountCents == null || amountCents <= 0) { setError('A counter needs a number.'); return }
    setBusy(true)
    setError(null)
    const input = {
      quoteId: quote.id,
      expectedVersion: quote.version,
      amountCents,
      message: message.trim() || undefined,
    }
    const answer = sell ? counterQuote(input) : counterOffer(input)
    answer
      .then((sendResult) => {
        setResult(sendResult)
        if (sendResult.sent) toast.success(`Countered at ${formatCents(amountCents)}`)
        else toast.warning('Countered — nothing was e-mailed, copy the link below')
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
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
      title={`Counter ${quote.id} — ${sell ? quote.customerName ?? 'customer' : quote.carrierName ?? 'carrier'}`}
      footer={
        result ? (
          <TmsButton variant="primary" onClick={onDone}>Done</TmsButton>
        ) : (
          <>
            <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
            <TmsButton
              variant="primary"
              aria-label="Send the counter"
              disabled={busy || amountCents == null || amountCents <= 0 || absorbError !== null}
              onClick={submit}
            >
              {busy ? 'Countering…' : 'Send counter'}
            </TmsButton>
          </>
        )
      }
    >
      {result === null && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="tms-grid tms-grid-2" style={{ fontSize: 13 }}>
            <div>
              <div className="tms-field-label">Ours</div>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(quote.amountCents)}</div>
            </div>
            <div>
              <div className="tms-field-label">Theirs</div>
              <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{theirs === null ? '—' : formatCents(theirs)}</div>
            </div>
          </div>

          <MoneyField label="Our counter" value={amountCents} onChange={setAmountCents} disabled={busy} />

          {sell && previewLines.length > 0 && (
            <div style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 8 }}>
              <div className="tms-field-label">Where the money lands</div>
              <table style={{ width: '100%', fontSize: 12 }}>
                <tbody>
                  {previewLines.map((row, index) => (
                    <tr key={`${row.priced.code}-${index}`}>
                      <td style={{ padding: '2px 0' }}>{row.draft?.label || humanChargeCode(row.priced.code)}</td>
                      <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCents(row.priced.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {absorbError && (
            <p className="tms-field-error" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <AlertTriangle size={13} style={{ marginTop: 2, flexShrink: 0 }} /> {absorbError}
            </p>
          )}

          <TmsField label="What to say with it" htmlFor="counter-message">
            <TmsTextarea
              id="counter-message"
              rows={2}
              value={message}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
            />
          </TmsField>

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      )}

      {result && (
        <div style={{ display: 'grid', gap: 12 }}>
          {result.sent === false && (
            <div style={{ borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-badge-orange)', background: 'rgba(255,136,10,0.12)', padding: 8, fontSize: 13 }}>
              Nothing was e-mailed. The counter is recorded and the link below is live — send it by hand.
            </div>
          )}
          {result.link && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={CODE_STYLE}>{result.link}</code>
              <TmsButton size="sm" aria-label="Copy counter link" onClick={() => copy(result.link ?? '', 'Link')}>
                <Link2 size={13} /> Copy
              </TmsButton>
            </div>
          )}
          <pre style={PRE_STYLE}>{result.body}</pre>
          <div>
            <TmsButton size="sm" aria-label="Copy e-mail body" onClick={() => copy(result.body, 'E-mail body')}>
              <Copy size={13} /> Copy the body
            </TmsButton>
          </div>
        </div>
      )}
    </TmsDialog>
  )
}
