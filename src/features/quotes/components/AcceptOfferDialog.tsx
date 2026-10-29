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
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
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
    if (carrier == null || leg == null) return null
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
  const unacknowledged = warnings.filter((warning) => acked.includes(warning.key) === false)
  const revenueCents = financials?.revenueCents ?? 0
  const profitCents = revenueCents - (rateCents ?? 0)

  const submit = () => {
    if (leg == null) { setError('The load behind this offer could not be read.'); return }
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

  const blocked = leg == null || carrier == null || blocks.length > 0 || unacknowledged.length > 0

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      className="tms-dialog-wide"
      title={`Book ${quote.carrierName ?? 'carrier'} — ${formatCents(theirNumberCents(quote) ?? quote.amountCents)}`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" aria-label="Book this carrier" disabled={busy || loading || blocked} onClick={submit}>
            {busy ? 'Booking…' : 'Accept and book'}
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <Loader2 size={14} /> Reading the shipment and the carrier's file…
        </p>
      )}

      {loading === false && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="tms-grid tms-grid-3" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 8, fontSize: 13 }}>
            <div>
              <div className="tms-field-label">Revenue</div>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(revenueCents)}</div>
            </div>
            <div>
              <div className="tms-field-label">Their number</div>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(theirNumberCents(quote) ?? quote.amountCents)}</div>
            </div>
            <div>
              <div className="tms-field-label">Profit</div>
              <div style={{ fontVariantNumeric: 'tabular-nums', color: profitCents < 0 ? 'var(--tms-badge-red)' : undefined }}>
                {formatCents(profitCents)}
              </div>
            </div>
          </div>

          {blocks.length > 0 && (
            <div style={{ borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-badge-red)', background: 'rgba(237,90,118,0.14)', padding: 8 }}>
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, fontWeight: 600, margin: 0 }}>
                <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0, color: 'var(--tms-badge-red)' }} />
                This carrier cannot be booked.
              </p>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--tms-badge-red)' }}>
                {blocks.map((block) => <li key={block.key}>{block.detail}</li>)}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div style={{ display: 'grid', gap: 8, borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-badge-orange)', background: 'rgba(255,136,10,0.12)', padding: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 600, margin: 0 }}>Read these and say so; the acknowledgement is kept on the booking.</p>
              {warnings.map((warning) => (
                <label key={warning.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    aria-label={`Acknowledge ${warning.key}`}
                    checked={acked.includes(warning.key)}
                    disabled={busy}
                    onChange={(e) => setAcked((prev) => (
                      e.target.checked ? [...prev, warning.key] : prev.filter((key) => key !== warning.key)
                    ))}
                  />
                  {warning.detail}
                </label>
              ))}
            </div>
          )}

          <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} disabled={busy} />

          <div className="tms-grid tms-grid-2">
            <Field label="Dispatcher" value={dispatcherName} disabled={busy} onChange={setDispatcherName} />
            <Field label="Dispatcher e-mail" value={dispatcherEmail} disabled={busy} onChange={setDispatcherEmail} />
            <Field label="Dispatcher phone" value={dispatcherPhone} disabled={busy} onChange={setDispatcherPhone} />
            <Field label="Driver" value={driverName} disabled={busy} onChange={setDriverName} />
            <Field label="Driver phone" value={driverPhone} disabled={busy} onChange={setDriverPhone} />
            <Field label="Truck #" value={truckNumber} disabled={busy} onChange={setTruckNumber} />
            <Field label="Trailer #" value={trailerNumber} disabled={busy} onChange={setTrailerNumber} />
            <TmsField label="Tracking" htmlFor="accept-offer-tracking">
              <TmsSelect
                id="accept-offer-tracking"
                value={trackingProvider}
                disabled={busy}
                onChange={(e) => setTrackingProvider(e.target.value as TrackingProvider)}
                options={TRACKING_PROVIDERS.map((provider) => ({ value: provider, label: provider }))}
              />
            </TmsField>
          </div>

          {leg == null && error == null && (
            <p className="tms-field-error">
              This offer does not name a shipment that can be read, so nothing can be booked against it.
            </p>
          )}

          {quote.groupId && (
            <p className="tms-muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TmsBadge tone="gray">Round {quote.rounds}</TmsBadge>
              Booking this one closes every other offer in the round.
            </p>
          )}

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}

function Field({ label, value, disabled, onChange }: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <TmsField label={label}>
      <TmsInput value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </TmsField>
  )
}
