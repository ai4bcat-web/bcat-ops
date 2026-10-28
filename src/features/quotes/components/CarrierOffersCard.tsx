/**
 * The buy side of a load, on the Carrier tab: who we asked, what we offered, what they
 * came back with, and the four things a dispatcher does about it.
 *
 * It sits above the assignment block because that is the order the work happens in —
 * offers out, then one of them booked. Once an assignment is ACTIVE the card stops being
 * a worklist and becomes the record of how this load got its carrier: no Request, no Log,
 * no per-row action, because the booking is already made and re-accepting a sibling offer
 * would book a second truck.
 *
 * The two numbers on a row are `ourOfferCents` and `carrierLastNumber` — the same pair the
 * public offer link shows the carrier, so the dispatcher and the carrier read the same
 * thing. Copy link is live only while `linkToken` is: the token is REMOVEd the moment the
 * carrier answers, and a dead link handed out is worse than none.
 */
import { useMemo, useState } from 'react'
import { Check, Copy, Handshake, Plus, RefreshCw, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLoadOffers } from '@/hooks/useLoadOffers'
import { rejectOffer } from '@/lib/apiClient'
import { quoteLinkFor } from '@/lib/quoteLinkClient'
import { carrierLastNumber, isOpenQuoteStatus, OFFER_STATUS_LABEL, ourOfferCents } from '@/lib/quotes'
import { formatCents } from '@/lib/tmsDirectory'
import { AcceptOfferDialog } from './AcceptOfferDialog'
import { CounterDialog } from './CounterDialog'
import { LogOfferDialog } from './LogOfferDialog'
import { RequestOffersDialog } from './RequestOffersDialog'
import { expiryChip, offerActions } from '../quoteViews'
import type { QuoteRecord, ShipmentBundle } from '@/types/tms'

type OfferDialog =
  | { kind: 'request' }
  | { kind: 'log' }
  | { kind: 'accept'; quote: QuoteRecord }
  | { kind: 'counter'; quote: QuoteRecord }
  | null

function money(cents: number | null | undefined): string {
  return cents == null ? '—' : `$${formatCents(cents)}`
}

export function CarrierOffersCard({ bundle, onReload }: {
  bundle: ShipmentBundle
  onReload: () => Promise<void> | void
}) {
  const load = bundle.loads[0]
  const loadId = load?.id ?? null
  const booked = bundle.loadCarriers.some((c) => c.status === 'ACTIVE')

  const { offers, loading, error, refresh } = useLoadOffers(loadId)
  const [dialog, setDialog] = useState<OfferDialog>(null)
  const [busy, setBusy] = useState(false)

  // Pinned at mount: a clock read during render is impure, and a countdown that
  // re-reads on every keystroke elsewhere on the page is noise, not freshness.
  const [nowIso] = useState(() => new Date().toISOString())
  const { open, closed } = useMemo(() => ({
    open: offers.filter((o) => isOpenQuoteStatus(o.status)),
    closed: offers.filter((o) => !isOpenQuoteStatus(o.status)),
  }), [offers])

  // Booked: the whole thread is history, in the order it happened.
  const rows = booked ? offers : open
  const history = booked ? [] : closed

  if (!loadId) return null

  const done = async () => {
    setDialog(null)
    await refresh()
    await onReload()
  }

  const reject = async (quote: QuoteRecord) => {
    setBusy(true)
    try {
      await rejectOffer({ quoteId: quote.id, expectedVersion: quote.version })
      toast.success(`Offer from ${quote.carrierName ?? 'the carrier'} rejected`)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reject the offer')
    } finally { setBusy(false) }
  }

  const copyLink = async (quote: QuoteRecord) => {
    if (!quote.linkToken) return
    await navigator.clipboard.writeText(quoteLinkFor(quote.linkToken))
    toast.success('Offer link copied')
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="carrier-offers">
      <div className="flex flex-wrap items-center gap-2">
        <Handshake size={14} className="text-muted-foreground" />
        <p className="text-sm font-medium">Carrier offers</p>
        {booked && <Badge variant="outline" className="text-[10px]">Booked — history only</Badge>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2"
          onClick={() => { void refresh() }}
          disabled={loading}
          aria-label="Refresh carrier offers"
        >
          <RefreshCw size={13} />
        </Button>
        {!booked && (
          <>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={() => setDialog({ kind: 'request' })} disabled={busy}>
              <Send size={13} className="mr-1" />Request offers
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setDialog({ kind: 'log' })} disabled={busy}>
              <Plus size={13} className="mr-1" />Log offer
            </Button>
          </>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {loading && offers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading offers…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {booked ? 'This load was booked without an offer on file.' : 'No offers out on this load yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((quote) => {
            const can = offerActions(quote, nowIso)
            const chip = expiryChip(quote, nowIso)
            return (
              <div key={quote.id} className="rounded-lg border border-border p-2" data-testid="carrier-offer-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{quote.carrierName ?? 'Carrier'}</span>
                  {quote.carrierMc && <Badge variant="outline" className="text-[10px]">MC {quote.carrierMc}</Badge>}
                  <Badge variant="outline" className="text-[10px]">{OFFER_STATUS_LABEL[quote.status]}</Badge>
                  <span className="text-xs text-muted-foreground">{quote.id}</span>
                  {chip && (
                    <span className={`text-xs ${chip.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {chip.text}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-sm">
                  <span>Ours <span className="font-medium">{money(ourOfferCents(quote))}</span></span>
                  <span className="text-muted-foreground">
                    Theirs <span className="font-medium text-foreground">{money(carrierLastNumber(quote))}</span>
                  </span>
                </div>

                {!booked && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy || !can.canAccept}
                      onClick={() => setDialog({ kind: 'accept', quote })}
                    >
                      <Check size={13} className="mr-1" />Accept
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy || !can.canCounter}
                      onClick={() => setDialog({ kind: 'counter', quote })}
                    >
                      Counter
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy || !can.canReject}
                      onClick={() => { void reject(quote) }}
                    >
                      <X size={13} className="mr-1" />Reject
                    </Button>
                    {can.canCopyLink && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => { void copyLink(quote) }}
                      >
                        <Copy size={13} className="mr-1" />Copy link
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {history.length} closed {history.length === 1 ? 'offer' : 'offers'}
          </summary>
          <div className="mt-2 space-y-1">
            {history.map((quote) => (
              <div key={quote.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{quote.carrierName ?? 'Carrier'}</span>
                <span>{OFFER_STATUS_LABEL[quote.status]}</span>
                <span>{money(carrierLastNumber(quote) ?? ourOfferCents(quote))}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <RequestOffersDialog
        shipmentId={bundle.shipment.id}
        loadId={loadId}
        open={dialog?.kind === 'request'}
        onOpenChange={(next) => { if (!next) setDialog(null) }}
        onDone={() => { void done() }}
      />
      <LogOfferDialog
        shipmentId={bundle.shipment.id}
        loadId={loadId}
        open={dialog?.kind === 'log'}
        onOpenChange={(next) => { if (!next) setDialog(null) }}
        onDone={() => { void done() }}
      />
      {dialog?.kind === 'accept' && (
        <AcceptOfferDialog
          quote={dialog.quote}
          open
          onOpenChange={(next) => { if (!next) setDialog(null) }}
          onDone={() => { void done() }}
        />
      )}
      {dialog?.kind === 'counter' && (
        <CounterDialog
          quote={dialog.quote}
          open
          onOpenChange={(next) => { if (!next) setDialog(null) }}
          onDone={() => { void done() }}
        />
      )}
    </div>
  )
}
