/**
 * Turning a won number into freight.
 *
 * Conversion is the only place a quote becomes WON, and it happens inside the same
 * transaction that writes the shipment, its load and its charges — so this dialog's job
 * is to say what is about to exist and whether the customer's credit will carry it. The
 * credit answer is `CHECK_CREDIT` with this quote's amount projected onto the customer's
 * open book: a hold is a refusal the server will repeat, a warning is a decision.
 *
 * The division and the rep are asked for here because the quote may not carry either and
 * the shipment must: freight nobody owns is freight nobody chases.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsSelect } from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { checkCredit, convertQuote, graphqlErrorText, listDivisions } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { quoteState } from '@/lib/quotes'
import type { CreditSummary } from '@/lib/customerCredit'
import type { Division, QuoteAcceptedVia, QuoteRecord } from '@/types/tms'

const ACCEPTED_VIA: { value: QuoteAcceptedVia; label: string }[] = [
  { value: 'LINK', label: 'They accepted on the link' },
  { value: 'PHONE', label: 'They accepted by phone' },
  { value: 'EMAIL', label: 'They accepted by e-mail' },
]

export function ConvertQuoteDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The shipment the quote became, so the caller can follow it. */
  onDone: (shipmentId: string | null) => void
}) {
  const user = useAuthUser()
  const [divisions, setDivisions] = useState<Division[]>([])
  const [credit, setCredit] = useState<CreditSummary | null>(null)
  const [divisionKey, setDivisionKey] = useState(quote.divisionKey ?? '')
  const [repId, setRepId] = useState(quote.customerRepId ?? user?.email ?? '')
  const [acceptedVia, setAcceptedVia] = useState<QuoteAcceptedVia>(
    quote.response === 'ACCEPTED' ? 'LINK' : 'PHONE',
  )
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { customerId, amountCents } = quote

  // Non-async on purpose (react-hooks/set-state-in-effect): the credit answer and the
  // divisions both land through one promise chain. A customer with no id has no credit
  // to check — the quote was written for a name, and conversion will refuse it.
  const load = useCallback(() =>
    Promise.all([
      listDivisions(),
      customerId ? checkCredit({ customerId, projectedCents: amountCents }) : Promise.resolve(null),
    ])
      .then(([divisionRows, creditSummary]) => {
        setDivisions(divisionRows)
        setCredit(creditSummary)
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [customerId, amountCents])

  useEffect(() => { load() }, [load])

  const state = quoteState(quote, new Date().toISOString())
  const stops = quote.stops ?? []
  const blocked = state.canConvert === false || customerId == null || credit?.hold === true

  const submit = () => {
    setBusy(true)
    setError(null)
    convertQuote({
      quoteId: quote.id,
      expectedVersion: quote.version,
      acceptedVia,
      divisionKey: divisionKey || null,
      customerRepId: repId.trim() || null,
    })
      .then((result) => {
        toast.success(`${quote.id} converted — shipment ${result.bundle.shipment.number}`)
        onDone(result.bundle.shipment.id)
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      className="tms-dialog-wide"
      title={`Convert ${quote.id} — ${formatCents(quote.amountCents)}`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" aria-label="Convert to shipment" disabled={busy || loading || blocked} onClick={submit}>
            {busy ? 'Converting…' : 'Convert to shipment'}
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <Loader2 size={14} /> Checking the customer's credit…
        </p>
      )}

      {loading === false && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 10 }}>
            <div className="tms-field-label">What this creates</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              <li>A shipment for {quote.customerName ?? 'this customer'} at {formatCents(quote.amountCents)}</li>
              <li>
                {stops.length} stop{stops.length === 1 ? '' : 's'}
                {quote.equipmentType ? ` on ${quote.equipmentType}` : ''}
                {quote.miles ? ` — ${quote.miles} mi` : ''}
              </li>
              <li>{(quote.lines ?? []).length} customer charge line{(quote.lines ?? []).length === 1 ? '' : 's'}, exactly as quoted</li>
            </ul>
          </div>

          {credit && (
            <div
              style={{
                border: `1px solid ${credit.hold ? 'var(--tms-badge-red)' : credit.warning ? 'var(--tms-badge-orange)' : 'var(--tms-border)'}`,
                background: credit.hold ? 'rgba(237,90,118,0.14)' : credit.warning ? 'rgba(255,136,10,0.12)' : 'transparent',
                borderRadius: 'var(--tms-radius)',
                padding: 10,
              }}
            >
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, fontWeight: 600, margin: 0 }}>
                {(credit.hold || credit.warning) && <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
                Credit — {formatCents(credit.usedCents)} used
                {credit.availableCents != null && `, ${formatCents(credit.availableCents)} left`}
                {credit.usageBps != null && <TmsBadge tone="gray">{(credit.usageBps / 100).toFixed(0)}% of limit</TmsBadge>}
              </p>
              {credit.blockReasons.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--tms-badge-red)' }}>
                  {credit.blockReasons.map((reason) => <li key={reason}>{reason.replace(/_/g, ' ').toLowerCase()}</li>)}
                </ul>
              )}
              {credit.hold && (
                <p style={{ marginTop: 4, fontSize: 12, color: 'var(--tms-badge-red)' }}>
                  Conversion is refused while the customer is on credit hold.
                </p>
              )}
            </div>
          )}

          {customerId == null && (
            <p className="tms-field-error">
              This quote was written for a name, not a customer record. Pick a customer on the quote first.
            </p>
          )}

          <div className="tms-grid tms-grid-2">
            <TmsField label="Division" htmlFor="convert-division">
              <TmsSelect
                id="convert-division"
                value={divisionKey}
                disabled={busy}
                onChange={(e) => setDivisionKey(e.target.value)}
                placeholder="Default"
                options={divisions.filter((d) => d.active).map((d) => ({ value: d.key, label: d.name }))}
              />
            </TmsField>
            <div className="tms-field">
              <span className="tms-field-label">Customer rep</span>
              <RepPicker
                role="CUSTOMER_REP"
                allowUnknown
                value={repId}
                onChange={setRepId}
                disabled={busy}
                placeholder="Pick a customer rep…"
              />
            </div>
          </div>

          <TmsField label="How they accepted" htmlFor="convert-via">
            <TmsSelect
              id="convert-via"
              value={acceptedVia}
              disabled={busy}
              onChange={(e) => setAcceptedVia(e.target.value as QuoteAcceptedVia)}
              options={ACCEPTED_VIA.map((option) => ({ value: option.value, label: option.label }))}
            />
          </TmsField>

          {state.canConvert === false && (
            <p className="tms-field-error">
              {state.expired
                ? 'This quote expired — send it again before booking freight against it.'
                : 'This quote is not on a rung that can be converted.'}
            </p>
          )}

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
