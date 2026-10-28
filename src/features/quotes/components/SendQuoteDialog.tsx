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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

  const unacknowledged = warnings.filter((warning) => !acked.includes(warning.key))
  const disabled = sending || loading
  const blocked = recipients.length === 0 || unacknowledged.length > 0 || !state.canSend

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {countering ? 'Counter' : 'Send'} quote {quote.id} — {formatCents(quote.amountCents)}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Reading the customer and the templates…
          </p>
        )}

        {!loading && !result && (
          <div className="space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Going to</Label>
              <p className="text-sm">
                {recipients.length > 0
                  ? recipients.map((email) => <Badge key={email} variant="outline" className="mr-1">{email}</Badge>)
                  : <span className="text-destructive">Nobody — this quote has no contact e-mail and the customer has no sales contact.</span>}
              </p>
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="send-quote-message">
                A line of your own (optional)
              </Label>
              <Textarea
                id="send-quote-message"
                rows={2}
                value={message}
                disabled={disabled}
                placeholder="anything the template does not already say"
                onChange={(e) => setMessage(e.target.value)}
                className="text-sm"
              />
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                What they will read — {preview.subject}
              </Label>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs">
                {preview.body}
              </pre>
              <p className="mt-1 text-xs text-muted-foreground">
                The link above is minted by the send itself; this preview shows where it lands.
              </p>
            </div>

            {warnings.length > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                <p className="flex items-start gap-2 text-xs font-medium">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  Read these before the number goes out; the acknowledgement is kept on the quote.
                </p>
                {warnings.map((warning) => (
                  <label key={warning.key} className="flex items-start gap-2 text-xs">
                    <Checkbox
                      aria-label={`Acknowledge ${warning.key}`}
                      checked={acked.includes(warning.key)}
                      disabled={disabled}
                      onCheckedChange={(v) => setAcked((prev) => (
                        v === true ? [...prev, warning.key] : prev.filter((key) => key !== warning.key)
                      ))}
                      className="mt-0.5"
                    />
                    <span>
                      {warning.message}
                      {warning.adminOnly && <Badge variant="outline" className="ml-1 text-[10px]">owner / admin</Badge>}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {!state.canSend && (
              <p className="text-xs text-destructive">
                This quote is not on a rung that can be sent — it is {quote.status.toLowerCase().replace('_', ' ')}.
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {result.sent ? (
              <p className="text-sm">
                Sent to {recipients.join(', ')}. The link is live until the quote expires.
              </p>
            ) : (
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                <p className="flex items-start gap-2 text-sm font-medium">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  Nothing was e-mailed. The quote is sent and the link is live — send it by hand.
                </p>
                <p className="text-xs text-muted-foreground">
                  This is the dev path: outbound mail is denied outside production, so the copy below is the
                  delivery. The quote row already says it went out, because the link works.
                </p>
              </div>
            )}

            {result.link && (
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">The link</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">{result.link}</code>
                  <Button size="sm" variant="outline" aria-label="Copy quote link" onClick={() => copy(result.link ?? '', 'Link')}>
                    <Link2 size={13} /> Copy
                  </Button>
                </div>
              </div>
            )}

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">{result.subject}</Label>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs">
                {result.body}
              </pre>
              <Button
                size="sm"
                variant="outline"
                className="mt-1"
                aria-label="Copy e-mail body"
                onClick={() => copy(result.body, 'E-mail body')}
              >
                <Copy size={13} /> Copy the body
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={onDone}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>Cancel</Button>
              <Button
                variant="outline"
                aria-label="Mint a link without e-mailing"
                disabled={disabled || !state.canSend}
                onClick={() => run('COPY')}
              >
                <Link2 size={14} /> Link only
              </Button>
              <Button aria-label="Send the quote" disabled={disabled || blocked} onClick={() => run('EMAIL')}>
                <Send size={14} /> {sending ? 'Sending…' : 'Send'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
