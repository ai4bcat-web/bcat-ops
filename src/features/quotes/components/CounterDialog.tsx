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
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { counterOffer, counterQuote, graphqlErrorText, type QuoteSendResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { absorbCounter, humanChargeCode } from '@/lib/quotes'
import { priceCharges } from '@/lib/shipmentCharges'
import { theirNumberCents } from '../quoteViews'
import type { LoadChargeInput, QuoteRecord } from '@/types/tms'

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
    if (!sell || amountCents == null || lines.length === 0) return null
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Counter {quote.id} — {sell ? quote.customerName ?? 'customer' : quote.carrierName ?? 'carrier'}</DialogTitle>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Ours</div>
                <div className="tabular-nums">{formatCents(quote.amountCents)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Theirs</div>
                <div className="tabular-nums font-medium">{theirs === null ? '—' : formatCents(theirs)}</div>
              </div>
            </div>

            <MoneyField label="Our counter" value={amountCents} onChange={setAmountCents} disabled={busy} />

            {sell && previewLines.length > 0 && (
              <div className="rounded-md border border-border p-2">
                <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                  Where the money lands
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {previewLines.map((row, index) => (
                      <tr key={`${row.priced.code}-${index}`}>
                        <td className="py-0.5">{row.draft?.label || humanChargeCode(row.priced.code)}</td>
                        <td className="py-0.5 text-right tabular-nums">{formatCents(row.priced.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {absorbError && (
              <p className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {absorbError}
              </p>
            )}

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="counter-message">
                What to say with it
              </Label>
              <Textarea
                id="counter-message"
                rows={2}
                value={message}
                disabled={busy}
                onChange={(e) => setMessage(e.target.value)}
                className="text-sm"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {!result.sent && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
                Nothing was e-mailed. The counter is recorded and the link below is live — send it by hand.
              </div>
            )}
            {result.link && (
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">{result.link}</code>
                <Button size="sm" variant="outline" aria-label="Copy counter link" onClick={() => copy(result.link ?? '', 'Link')}>
                  <Link2 size={13} /> Copy
                </Button>
              </div>
            )}
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs">
              {result.body}
            </pre>
            <Button size="sm" variant="outline" aria-label="Copy e-mail body" onClick={() => copy(result.body, 'E-mail body')}>
              <Copy size={13} /> Copy the body
            </Button>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={onDone}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button
                aria-label="Send the counter"
                disabled={busy || amountCents == null || amountCents <= 0 || absorbError !== null}
                onClick={submit}
              >
                {busy ? 'Countering…' : 'Send counter'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
