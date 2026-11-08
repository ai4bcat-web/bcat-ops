/**
 * The buy side of a shipment, on the Carrier tab: who we asked, what we offered, what
 * they came back with, and the four things a dispatcher does about it.
 *
 * It sits above the assignment block because that is the order the work happens in —
 * offers out, then one of them booked. Once an assignment is ACTIVE the card stops being
 * a worklist and becomes the record of how this shipment got its carrier: no Request, no
 * Log, no per-row action, because the booking is already made and re-accepting a sibling
 * offer would book a second truck.
 *
 * The two numbers on a row are `ourOfferCents` and `carrierLastNumber` — the same pair the
 * public offer link shows the carrier, so the dispatcher and the carrier read the same
 * thing. Copy link is live only while `linkToken` is: the token is REMOVEd the moment the
 * carrier answers, and a dead link handed out is worse than none.
 */
import { useMemo, useState } from 'react'
import { Check, Copy, Plus, RefreshCw, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsIconButton } from '@/features/tms/kit'
import { useLoadOffers } from '@/hooks/useLoadOffers'
import { rejectOffer } from '@/lib/apiClient'
import { quoteLinkFor } from '@/lib/quoteLinkClient'
import { carrierLastNumber, isOpenQuoteStatus, OFFER_STATUS_LABEL, ourOfferCents } from '@/lib/quotes'
import { formatCents } from '@/lib/invoiceBuild'
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
  return cents == null ? '—' : formatCents(cents)
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
    closed: offers.filter((o) => isOpenQuoteStatus(o.status) === false),
  }), [offers])

  // Booked: the whole thread is history, in the order it happened.
  const rows = booked ? offers : open
  const history = booked ? [] : closed

  if (loadId == null) return null

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
    <TmsCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Carrier offers
          {booked && <TmsBadge tone="gray">Booked — history only</TmsBadge>}
        </span>
      }
      actions={
        <>
          <TmsIconButton shape="plain" aria-label="Refresh carrier offers" disabled={loading} onClick={() => { void refresh() }}>
            <RefreshCw size={13} />
          </TmsIconButton>
          {booked === false && (
            <>
              <TmsButton variant="primary" size="sm" onClick={() => setDialog({ kind: 'request' })} disabled={busy}>
                <Send size={13} />Request offers
              </TmsButton>
              <TmsButton size="sm" onClick={() => setDialog({ kind: 'log' })} disabled={busy}>
                <Plus size={13} />Log offer
              </TmsButton>
            </>
          )}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }} data-testid="carrier-offers">
        {error && <p className="tms-field-error">{error}</p>}

        {loading && offers.length === 0 ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>Loading offers…</p>
        ) : rows.length === 0 ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>
            {booked ? 'This shipment was booked without an offer on file.' : 'No offers out on this shipment yet.'}
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map((quote) => {
              const can = offerActions(quote, nowIso)
              const chip = expiryChip(quote, nowIso)
              return (
                <div
                  key={quote.id}
                  style={{ borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)', padding: 8 }}
                  data-testid="carrier-offer-row"
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{quote.carrierName ?? 'Carrier'}</span>
                    {quote.carrierMc && <TmsBadge tone="gray">MC {quote.carrierMc}</TmsBadge>}
                    <TmsBadge tone="blue">{OFFER_STATUS_LABEL[quote.status]}</TmsBadge>
                    <span className="tms-muted" style={{ fontSize: 12 }}>{quote.id}</span>
                    {chip && (
                      <span
                        className={chip.tone === 'danger' ? undefined : 'tms-muted'}
                        style={{ fontSize: 12, color: chip.tone === 'danger' ? 'var(--tms-badge-red)' : undefined }}
                      >
                        {chip.text}
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 13 }}>
                    <span>Ours <span style={{ fontWeight: 600 }}>{money(ourOfferCents(quote))}</span></span>
                    <span className="tms-muted">
                      Theirs <span style={{ fontWeight: 600, color: 'var(--tms-text)' }}>{money(carrierLastNumber(quote))}</span>
                    </span>
                  </div>

                  {booked === false && (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <TmsButton
                        variant="primary"
                        size="sm"
                        disabled={busy || can.canAccept === false}
                        onClick={() => setDialog({ kind: 'accept', quote })}
                      >
                        <Check size={13} />Accept
                      </TmsButton>
                      <TmsButton size="sm" disabled={busy || can.canCounter === false} onClick={() => setDialog({ kind: 'counter', quote })}>
                        Counter
                      </TmsButton>
                      <TmsButton size="sm" disabled={busy || can.canReject === false} onClick={() => { void reject(quote) }}>
                        <X size={13} />Reject
                      </TmsButton>
                      {can.canCopyLink && (
                        <TmsButton variant="ghost" size="sm" onClick={() => { void copyLink(quote) }}>
                          <Copy size={13} />Copy link
                        </TmsButton>
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
            <summary className="tms-muted" style={{ cursor: 'pointer', fontSize: 12 }}>
              {history.length} closed {history.length === 1 ? 'offer' : 'offers'}
            </summary>
            <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              {history.map((quote) => (
                <div key={quote.id} className="tms-muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
                  <span>{quote.carrierName ?? 'Carrier'}</span>
                  <span>{OFFER_STATUS_LABEL[quote.status]}</span>
                  <span>{money(carrierLastNumber(quote) ?? ourOfferCents(quote))}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

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
    </TmsCard>
  )
}
