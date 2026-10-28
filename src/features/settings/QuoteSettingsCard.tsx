/**
 * Quotes & offers: the house rules every quote is numbered, timed and sent under.
 *
 * Three of these are refused here rather than discovered later. A quote e-mail with no
 * `{link}` cannot be answered at all — the whole point of the link is that the customer
 * or carrier replies without signing in — so all three bodies go through the same
 * `quoteTemplateError` the send actions refuse with. A number format with no counter
 * would hand every quote the same number, and the number IS the row's id, so a collision
 * is a refused write rather than a duplicate: it is checked through
 * `quoteNumberFormatError`, the same function the mint refuses with. The live example
 * underneath is rendered by the real `quoteNumber` against the real next number.
 *
 * The next number is editable here, unlike the invoice counter: a quote number is minted
 * with a compare-and-set on this field and a Put conditioned on the id not existing, so a
 * value an admin sets too low is refused at mint instead of overwriting a live quote.
 *
 * Both checkboxes are permissions rather than preferences, and the Lambda enforces them
 * whatever this card says: a below-margin quote needs an admin to go out, and a carrier's
 * offer link shows the book-now number only while the second box is ticked.
 */
import { useEffect, useState } from 'react'
import { FileSpreadsheet, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getTmsSettings, saveQuoteSettings } from '@/lib/apiClient'
import {
  DEFAULT_HOURS_TO_QUOTE, DEFAULT_OFFER_EXPIRY_HOURS, DEFAULT_QUOTE_NUMBER_FORMAT,
  quoteNumber, quoteNumberFormatError,
} from '@/lib/quotes'
import {
  DEFAULT_COUNTER_EMAIL_TEMPLATE, DEFAULT_OFFER_REQUEST_EMAIL_TEMPLATE,
  DEFAULT_QUOTE_EMAIL_TEMPLATE, quoteTemplateError,
} from '@/lib/quoteNotices'
import type { TmsSettings } from '@/types/tms'

/** An hours box: blank means "the house default", anything else must be a whole number ≥ 1. */
function hoursError(raw: string, what: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) return `${what} must be a whole number of hours, at least 1`
  return null
}

function hoursValue(raw: string): number | null {
  const text = raw.trim()
  return text ? Number(text) : null
}

export function QuoteSettingsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [hoursToQuote, setHoursToQuote] = useState('')
  const [offerExpiryHours, setOfferExpiryHours] = useState('')
  const [numberFormat, setNumberFormat] = useState('')
  const [nextNumber, setNextNumber] = useState('')
  const [quoteTemplate, setQuoteTemplate] = useState('')
  const [counterTemplate, setCounterTemplate] = useState('')
  const [offerTemplate, setOfferTemplate] = useState('')
  const [terms, setTerms] = useState('')
  const [belowMarginAdminOnly, setBelowMarginAdminOnly] = useState(true)
  const [carrierSeesBookNow, setCarrierSeesBookNow] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setHoursToQuote(s?.hoursToQuote != null ? String(s.hoursToQuote) : '')
        setOfferExpiryHours(s?.offerExpiryHours != null ? String(s.offerExpiryHours) : '')
        setNumberFormat(s?.quoteNumberFormat ?? '')
        setNextNumber(s?.nextQuoteNumber != null ? String(s.nextQuoteNumber) : '')
        setQuoteTemplate(s?.quoteEmailTemplate ?? '')
        setCounterTemplate(s?.counterEmailTemplate ?? '')
        setOfferTemplate(s?.offerRequestEmailTemplate ?? '')
        setTerms(s?.quoteTermsText ?? '')
        // Both are permissions, and both are on unless somebody opened them up.
        setBelowMarginAdminOnly(s?.quoteBelowMinMarginAdminOnly !== false)
        setCarrierSeesBookNow(s?.quoteOffersCarrierSeesBookNow !== false)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const effectiveFormat = numberFormat.trim() || DEFAULT_QUOTE_NUMBER_FORMAT
  const formatError = quoteNumberFormatError(effectiveFormat)
  const nextN = nextNumber.trim() ? Number(nextNumber.trim()) : 1
  const example = formatError || !Number.isInteger(nextN) || nextN < 1
    ? null
    : quoteNumber(effectiveFormat, nextN, new Date().toISOString().slice(0, 10))

  const save = async () => {
    setError(null)

    const first = formatError
      ?? hoursError(hoursToQuote, 'Hours to quote')
      ?? hoursError(offerExpiryHours, 'Offer expiry')
      ?? (nextNumber.trim() && (!Number.isInteger(nextN) || nextN < 1)
        ? 'The next quote number must be a whole number, at least 1'
        : null)
      ?? quoteTemplateError(quoteTemplate)
      ?? quoteTemplateError(counterTemplate)
      ?? quoteTemplateError(offerTemplate)
    if (first) {
      setError(first)
      return
    }

    setSaving(true)
    try {
      await saveQuoteSettings({
        hoursToQuote: hoursValue(hoursToQuote),
        offerExpiryHours: hoursValue(offerExpiryHours),
        // A blank box is "the house default", not an empty format.
        quoteNumberFormat: numberFormat.trim() || null,
        nextQuoteNumber: nextNumber.trim() ? nextN : null,
        quoteEmailTemplate: quoteTemplate.trim() || null,
        counterEmailTemplate: counterTemplate.trim() || null,
        offerRequestEmailTemplate: offerTemplate.trim() || null,
        quoteTermsText: terms.trim() || null,
        quoteBelowMinMarginAdminOnly: belowMarginAdminOnly,
        quoteOffersCarrierSeesBookNow: carrierSeesBookNow,
      })
      toast.success('Quote settings saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <FileSpreadsheet size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Quotes &amp; offers</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            How long a quote stands, how quotes are numbered, what the e-mails say, and who may send one below margin.
          </div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Hours to quote</Label>
              <Input
                aria-label="Hours to quote"
                inputMode="numeric"
                value={hoursToQuote}
                onChange={(e) => setHoursToQuote(e.target.value)}
                placeholder={String(DEFAULT_HOURS_TO_QUOTE)}
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                How long a customer has to answer. A customer&rsquo;s own quoting default beats this one; blank means {DEFAULT_HOURS_TO_QUOTE} hours.
              </p>
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Offer expiry hours</Label>
              <Input
                aria-label="Offer expiry hours"
                inputMode="numeric"
                value={offerExpiryHours}
                onChange={(e) => setOfferExpiryHours(e.target.value)}
                placeholder={String(DEFAULT_OFFER_EXPIRY_HOURS)}
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                How long a carrier has to answer an offer. Capped at the first pickup appointment, and never under an hour.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Quote number format</Label>
              <Input
                aria-label="Quote number format"
                value={numberFormat}
                onChange={(e) => setNumberFormat(e.target.value)}
                placeholder={DEFAULT_QUOTE_NUMBER_FORMAT}
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {'{yyyy}'} is the year, {'{n}'} or {'{n:6}'} the counter.{' '}
                {formatError
                  ? <span className="text-destructive">{formatError}.</span>
                  : example && <>Next quote: <span className="font-medium text-foreground" data-testid="quote-number-example">{example}</span></>}
              </p>
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next number</Label>
              <Input
                aria-label="Next quote number"
                inputMode="numeric"
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
                placeholder="1"
                className="h-9 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The quote number is the quote&rsquo;s id. Setting this back over a number already used is refused when the quote is minted.
              </p>
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Quote e-mail</Label>
            <Textarea
              aria-label="Quote email template"
              rows={3}
              value={quoteTemplate}
              onChange={(e) => setQuoteTemplate(e.target.value)}
              placeholder={DEFAULT_QUOTE_EMAIL_TEMPLATE}
              className="text-sm"
            />
          </div>

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Counter e-mail</Label>
            <Textarea
              aria-label="Counter email template"
              rows={3}
              value={counterTemplate}
              onChange={(e) => setCounterTemplate(e.target.value)}
              placeholder={DEFAULT_COUNTER_EMAIL_TEMPLATE}
              className="text-sm"
            />
          </div>

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Carrier offer request</Label>
            <Textarea
              aria-label="Offer request email template"
              rows={3}
              value={offerTemplate}
              onChange={(e) => setOfferTemplate(e.target.value)}
              placeholder={DEFAULT_OFFER_REQUEST_EMAIL_TEMPLATE}
              className="text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {'{number}'}, {'{lane}'}, {'{amount}'} and {'{pickup}'} are filled in. {'{link}'} is required in all three — without it there is nothing to accept.
            </p>
          </div>

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Quote terms</Label>
            <Textarea
              aria-label="Quote terms"
              rows={3}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Shown at the foot of every quote link and e-mail."
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="Below margin admin only"
                checked={belowMarginAdminOnly}
                onCheckedChange={(v) => setBelowMarginAdminOnly(v === true)}
              />
              Only an admin may send a quote below the customer&rsquo;s minimum margin
            </label>
            <label className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="Carrier sees book now rate"
                checked={carrierSeesBookNow}
                onCheckedChange={(v) => setCarrierSeesBookNow(v === true)}
              />
              A carrier&rsquo;s offer link shows the book-now rate
            </label>
            <p className="text-xs text-muted-foreground">
              A carrier who accepts the book-now rate still books nothing: a dispatcher accepts the offer here.
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save quote settings
          </Button>
        </div>
      )}
    </div>
  )
}
