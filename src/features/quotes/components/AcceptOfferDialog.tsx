/**
 * Booking the carrier who answered.
 *
 * Accepting an offer is a booking, not a bookkeeping entry: `ACCEPT_OFFER` demands
 * everything `BOOK_CARRIER` demands and refuses with the same sentences, so this form is
 * the booking form with the carrier and the rate already filled in from the offer. The
 * gate is `evaluateCarrierBooking` — the same function the Lambda runs — recomputed on
 * every keystroke, so a blocked carrier is visible before the button is pressed rather
 * than after.
 *
 * Blocks cannot be waved through here or anywhere. Each warning is acknowledged by its
 * machine `key`, which is what the server matches its own answer against.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { useAuth } from '@/hooks/useAuth'
import {
  acceptOffer, getCarrierBundle, getShipmentBundle, getTmsSettings, graphqlErrorText,
} from '@/lib/apiClient'
import { evaluateCarrierBooking } from '@/lib/carrierEligibility'
import { formatCents } from '@/lib/invoiceBuild'
import { theirNumberCents } from '../quoteViews'
import type { CarrierBundle, QuoteRecord, ShipmentBundle, TmsSettings, TrackingProvider } from '@/types/tms'

const TRACKING_PROVIDERS: TrackingProvider[] = ['NONE', 'MANUAL', 'LINK', 'DRIVER_APP', 'MOTIVE']

export function AcceptOfferDialog({ quote, open, onOpenChange, onDone }: {
  quote: QuoteRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const { isAdmin } = useAuth()
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [carrierBundle, setCarrierBundle] = useState<CarrierBundle | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [rateCents, setRateCents] = useState<number | null>(theirNumberCents(quote) ?? quote.amountCents)
  const [dispatcherName, setDispatcherName] = useState(quote.contactName ?? '')
  const [dispatcherEmail, setDispatcherEmail] = useState(quote.carrierEmail ?? '')
  const [dispatcherPhone, setDispatcherPhone] = useState('')
  const [driverName, setDriverName] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [truckNumber, setTruckNumber] = useState('')
  const [trailerNumber, setTrailerNumber] = useState('')
  const [trackingProvider, setTrackingProvider] = useState<TrackingProvider>('NONE')
  const [acked, setAcked] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { shipmentId, carrierId, loadId } = quote

  // Non-async on purpose (react-hooks/set-state-in-effect): the shipment, the carrier
  // and the org settings all land through one promise chain, and a failed read leaves
  // the gate unanswered rather than wrongly clear.
  const load = useCallback(() =>
    Promise.all([
      shipmentId ? getShipmentBundle(shipmentId) : Promise.resolve(null),
      carrierId ? getCarrierBundle(carrierId) : Promise.resolve(null),
      getTmsSettings(),
    ])
      .then(([shipment, carrier, tmsSettings]) => {
        setBundle(shipment)
        setCarrierBundle(carrier)
        setSettings(tmsSettings)
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [shipmentId, carrierId])

  useEffect(() => { load() }, [load])

  const leg = bundle?.loads.find((row) => row.id === loadId) ?? bundle?.loads[0] ?? null
  const order = bundle?.orders[0] ?? null
  const financials = bundle?.financials[0] ?? null
  const carrier = carrierBundle?.carrier ?? null

  const preview = useMemo(() => {
    if (!carrier || !leg) return null
    return evaluateCarrierBooking({
      carrier,
      documents: carrierBundle?.documents ?? [],
      load: {
        id: leg.id,
        pickupAppt: leg.pickupAppt ?? null,
        commodity: leg.commodity ?? null,
        weight: leg.weight ?? null,
        cargoValueCents: leg.cargoValueCents ?? null,
        freightDescription: order?.freight?.[0]?.description ?? null,
        activeLoadCarrierId: leg.activeLoadCarrierId ?? null,
        assignmentType: leg.assignmentType ?? null,
      },
      financials: { topSpendCents: financials?.topSpendCents ?? null },
      carrierRateCents: rateCents ?? 0,
      otherActiveLoadCarriers: (carrierBundle?.loadCarriers ?? [])
        .filter((assignment) => assignment.status === 'ACTIVE' && assignment.loadId !== leg.id)
        .map((assignment) => ({ loadId: assignment.loadId, pickupAppt: null })),
      settings,
      now: new Date(),
      isAdmin,
    })
  }, [carrier, carrierBundle, leg, order, financials, rateCents, settings, isAdmin])

  const blocks = preview?.blocks ?? []
  const warnings = preview?.warnings ?? []
  const unacknowledged = warnings.filter((warning) => !acked.includes(warning.key))
  const revenueCents = financials?.revenueCents ?? 0
  const profitCents = revenueCents - (rateCents ?? 0)

  const submit = () => {
    if (!leg) { setError('The load behind this offer could not be read.'); return }
    if (rateCents == null || rateCents <= 0) { setError('A booking needs a rate.'); return }
    setBusy(true)
    setError(null)
    acceptOffer({
      quoteId: quote.id,
      expectedVersion: quote.version,
      loadId: leg.id,
      // The load's own CAS token when it has one; the shipment's otherwise, exactly as
      // the shipment page books (`useShipmentActions`).
      expectedUpdatedAt: leg.updatedAt ?? bundle?.shipment.updatedAt ?? '',
      carrierRateCents: rateCents,
      dispatcherName: dispatcherName.trim() || null,
      dispatcherEmail: dispatcherEmail.trim() || null,
      dispatcherPhone: dispatcherPhone.trim() || null,
      driverName: driverName.trim() || null,
      driverPhone: driverPhone.trim() || null,
      truckNumber: truckNumber.trim() || null,
      trailerNumber: trailerNumber.trim() || null,
      trackingProvider,
      acknowledgeWarnings: warnings.map((warning) => warning.key),
    })
      .then(() => {
        toast.success(`${quote.carrierName ?? 'Carrier'} booked at ${formatCents(rateCents)}`)
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
  }

  const blocked = !leg || !carrier || blocks.length > 0 || unacknowledged.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Book {quote.carrierName ?? 'carrier'} — {formatCents(theirNumberCents(quote) ?? quote.amountCents)}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Reading the load and the carrier's file…
          </p>
        )}

        {!loading && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3 rounded-md border border-border p-2 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Revenue</div>
                <div className="tabular-nums">{formatCents(revenueCents)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Their number</div>
                <div className="tabular-nums">{formatCents(theirNumberCents(quote) ?? quote.amountCents)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Profit</div>
                <div className={profitCents < 0 ? 'tabular-nums text-destructive' : 'tabular-nums'}>
                  {formatCents(profitCents)}
                </div>
              </div>
            </div>

            {blocks.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2">
                <p className="flex items-start gap-2 text-xs font-medium">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
                  This carrier cannot be booked.
                </p>
                <ul className="mt-1 space-y-1 text-xs text-destructive">
                  {blocks.map((block) => <li key={block.key}>{block.detail}</li>)}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                <p className="text-xs font-medium">Read these and say so; the acknowledgement is kept on the booking.</p>
                {warnings.map((warning) => (
                  <label key={warning.key} className="flex items-start gap-2 text-xs">
                    <Checkbox
                      aria-label={`Acknowledge ${warning.key}`}
                      checked={acked.includes(warning.key)}
                      disabled={busy}
                      onCheckedChange={(v) => setAcked((prev) => (
                        v === true ? [...prev, warning.key] : prev.filter((key) => key !== warning.key)
                      ))}
                      className="mt-0.5"
                    />
                    {warning.detail}
                  </label>
                ))}
              </div>
            )}

            <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} disabled={busy} />

            <div className="grid grid-cols-2 gap-3">
              <Field label="Dispatcher" value={dispatcherName} disabled={busy} onChange={setDispatcherName} />
              <Field label="Dispatcher e-mail" value={dispatcherEmail} disabled={busy} onChange={setDispatcherEmail} />
              <Field label="Dispatcher phone" value={dispatcherPhone} disabled={busy} onChange={setDispatcherPhone} />
              <Field label="Driver" value={driverName} disabled={busy} onChange={setDriverName} />
              <Field label="Driver phone" value={driverPhone} disabled={busy} onChange={setDriverPhone} />
              <Field label="Truck #" value={truckNumber} disabled={busy} onChange={setTruckNumber} />
              <Field label="Trailer #" value={trailerNumber} disabled={busy} onChange={setTrailerNumber} />
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="accept-offer-tracking">
                  Tracking
                </Label>
                <select
                  id="accept-offer-tracking"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={trackingProvider}
                  disabled={busy}
                  onChange={(e) => setTrackingProvider(e.target.value as TrackingProvider)}
                >
                  {TRACKING_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </select>
              </div>
            </div>

            {!leg && !error && (
              <p className="text-xs text-destructive">
                This offer does not name a load that can be read, so nothing can be booked against it.
              </p>
            )}

            {quote.groupId && (
              <p className="text-xs text-muted-foreground">
                <Badge variant="outline" className="mr-1 text-[10px]">Round {quote.rounds}</Badge>
                Booking this one closes every other offer in the round.
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button aria-label="Book this carrier" disabled={busy || loading || blocked} onClick={submit}>
            {busy ? 'Booking…' : 'Accept and book'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, disabled, onChange }: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input
        aria-label={label}
        className="h-9 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
