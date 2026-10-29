/**
 * The multi-truck ask: one lane, priced once, quoted five times.
 *
 * Each copy is its own quote with its own number and its own pickup day — a customer who
 * takes three of the five leaves two to lose, and a single row could not say that. The
 * copies carry no link: a duplicate that inherited the original's token would let one
 * customer's answer land on two quotes.
 *
 * The exposure figure is what those copies would add to this customer's open book if they
 * all landed. It is a warning here and a refusal at conversion — quoting freight is not
 * extending credit, and the desk is allowed to quote past the limit knowing it.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { duplicateQuotes, graphqlErrorText, type DuplicateQuotesResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import type { QuoteRecord } from '@/types/tms'

const MAX_COPIES = 25

/** `2026-03-18T15:00:00.000Z` → `2026-03-18T15:00`, which is what a datetime input eats. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function DuplicateQuoteDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [count, setCount] = useState(2)
  const [appts, setAppts] = useState<string[]>(() => [toLocalInput(quote.pickupAppt), ''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DuplicateQuotesResult | null>(null)

  const rows = useMemo(
    () => Array.from({ length: count }, (_, index) => appts[index] ?? ''),
    [count, appts],
  )

  const setCopies = (next: number) => {
    const clamped = Math.min(Math.max(next, 1), MAX_COPIES)
    setCount(clamped)
    setAppts((prev) => Array.from({ length: clamped }, (_, index) => prev[index] ?? ''))
  }

  const submit = () => {
    setBusy(true)
    setError(null)
    duplicateQuotes({
      quoteId: quote.id,
      count,
      pickupAppts: rows.map((value) => (value ? new Date(value).toISOString() : null)),
    })
      .then((answer) => {
        setResult(answer)
        toast.success(`${answer.quotes.length} quote${answer.quotes.length === 1 ? '' : 's'} created`)
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
  }

  const projectedCents = (result?.exposure.projectedCents ?? quote.amountCents * count)
  const limitCents = result?.exposure.creditLimitCents ?? null

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Duplicate ${quote.id} — ${formatCents(quote.amountCents)} each`}
      footer={
        result ? (
          <TmsButton variant="primary" onClick={onDone}>Done</TmsButton>
        ) : (
          <>
            <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
            <TmsButton variant="primary" aria-label="Duplicate the quote" disabled={busy} onClick={submit}>
              {busy ? 'Copying…' : `Create ${count} quote${count === 1 ? '' : 's'}`}
            </TmsButton>
          </>
        )
      }
    >
      {result === null && (
        <div style={{ display: 'grid', gap: 12 }}>
          <TmsField label="How many trucks" htmlFor="duplicate-count">
            <TmsInput
              id="duplicate-count"
              type="number"
              min={1}
              max={MAX_COPIES}
              style={{ width: 96 }}
              value={count}
              disabled={busy}
              onChange={(e) => setCopies(Number(e.target.value) || 1)}
            />
          </TmsField>

          <div style={{ display: 'grid', gap: 8 }}>
            <span className="tms-field-label">Pickup for each copy</span>
            {rows.map((value, index) => (
              <TmsInput
                key={index}
                type="datetime-local"
                aria-label={`Pickup for copy ${index + 1}`}
                value={value}
                disabled={busy}
                onChange={(e) => setAppts((prev) => {
                  const next = [...prev]
                  next[index] = e.target.value
                  return next
                })}
              />
            ))}
            <p className="tms-muted" style={{ fontSize: 12 }}>
              Leave a day blank to keep the original's pickup.
            </p>
          </div>

          <div style={{ borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)', padding: 8, fontSize: 13 }}>
            <div className="tms-field-label">If every copy lands</div>
            <div style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(projectedCents)} on this customer's book</div>
          </div>

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      )}

      {result && (
        <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
          <p>
            {result.quotes.length} quote{result.quotes.length === 1 ? '' : 's'} created:{' '}
            {result.quotes.map((row) => row.id).join(', ')}. None of them carries a link until it is sent.
          </p>
          <div
            style={{
              borderRadius: 'var(--tms-radius)',
              border: `1px solid ${result.exposure.overLimit ? 'var(--tms-badge-orange)' : 'var(--tms-border)'}`,
              background: result.exposure.overLimit ? 'rgba(255,136,10,0.12)' : 'transparent',
              padding: 8,
            }}
          >
            <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, margin: 0 }}>
              {result.exposure.overLimit && <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0, color: 'var(--tms-badge-orange)' }} />}
              Projected exposure {formatCents(result.exposure.projectedCents)}
              {limitCents != null && ` against a ${formatCents(limitCents)} limit`}
              {result.exposure.overLimit && ' — conversion will be refused until the book comes down.'}
            </p>
          </div>
        </div>
      )}
    </TmsDialog>
  )
}
