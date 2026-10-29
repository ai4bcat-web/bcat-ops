/**
 * Turning a won number into freight.
 *
 * Conversion is the only place a quote becomes WON, and it happens inside the same
 * transaction that writes the order, the load and the charges — so this dialog's job is
 * to say what is about to exist and whether the customer's credit will carry it. The
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
  const blocked = !state.canConvert || !customerId || credit?.hold === true

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Convert {quote.id} — {formatCents(quote.amountCents)}</DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Checking the customer's credit…
          </p>
        )}

        {!loading && (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-2 text-sm">
              <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">What this creates</div>
              <ul className="space-y-0.5 text-sm">
                <li>An order for {quote.customerName ?? 'this customer'} at {formatCents(quote.amountCents)}</li>
                <li>
                  One load over {stops.length} stop{stops.length === 1 ? '' : 's'}
                  {quote.equipmentType ? ` on ${quote.equipmentType}` : ''}
                  {quote.miles ? ` — ${quote.miles} mi` : ''}
                </li>
                <li>{(quote.lines ?? []).length} customer charge line{(quote.lines ?? []).length === 1 ? '' : 's'}, exactly as quoted</li>
              </ul>
            </div>

            {credit && (
              <div
                className={
                  credit.hold
                    ? 'rounded-lg border border-destructive/40 bg-destructive/10 p-2'
                    : credit.warning
                      ? 'rounded-lg border border-amber-500/40 bg-amber-500/10 p-2'
                      : 'rounded-md border border-border p-2'
                }
              >
                <p className="flex items-start gap-2 text-xs font-medium">
                  {(credit.hold || credit.warning) && <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
                  Credit — {formatCents(credit.usedCents)} used
                  {credit.availableCents != null && `, ${formatCents(credit.availableCents)} left`}
                  {credit.usageBps != null && (
                    <Badge variant="outline" className="ml-1 text-[10px]">{(credit.usageBps / 100).toFixed(0)}% of limit</Badge>
                  )}
                </p>
                {credit.blockReasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                    {credit.blockReasons.map((reason) => <li key={reason}>{reason.replace(/_/g, ' ').toLowerCase()}</li>)}
                  </ul>
                )}
                {credit.hold && (
                  <p className="mt-1 text-xs text-destructive">
                    Conversion is refused while the customer is on credit hold.
                  </p>
                )}
              </div>
            )}

            {!customerId && (
              <p className="text-xs text-destructive">
                This quote was written for a name, not a customer record. Pick a customer on the quote first.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="convert-division">
                  Division
                </Label>
                <select
                  id="convert-division"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={divisionKey}
                  disabled={busy}
                  onChange={(e) => setDivisionKey(e.target.value)}
                >
                  <option value="">Default</option>
                  {divisions.filter((d) => d.active).map((d) => (
                    <option key={d.id} value={d.key}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Customer rep
                </Label>
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

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="convert-via">
                How they accepted
              </Label>
              <select
                id="convert-via"
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={acceptedVia}
                disabled={busy}
                onChange={(e) => setAcceptedVia(e.target.value as QuoteAcceptedVia)}
              >
                {ACCEPTED_VIA.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            {!state.canConvert && (
              <p className="text-xs text-destructive">
                {state.expired
                  ? 'This quote expired — send it again before booking freight against it.'
                  : 'This quote is not on a rung that can be converted.'}
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button aria-label="Convert to shipment" disabled={busy || loading || blocked} onClick={submit}>
            {busy ? 'Converting…' : 'Convert to shipment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
