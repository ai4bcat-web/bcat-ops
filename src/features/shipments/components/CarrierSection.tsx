/**
 * The Carrier/Driver tab of a shipment: who is hauling it, what they are being paid,
 * where the rate confirmation got to, and the three things that end a booking —
 * dispatch, bounce, TONU (spec §6.2).
 *
 * Own-fleet assignments land here too, but with none of the carrier paperwork: a driver
 * on our payroll has no rate con to sign and no quick-pay fee to deduct. What they do
 * have is the rest of BCAT Ops — booking Ivan Cartage puts the shipment on the calendar,
 * in dispatch and in that driver's settlement — so the card says so and links there.
 *
 * What the leg costs is on the Carrier Pay tab; this tab is the booking, not the bill.
 *
 * The offers card sits above all of it, because asking carriers comes before booking one:
 * it is the only thing on this tab a load with nobody on it still has.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, Send, Truck, UserMinus } from 'lucide-react'
import { RateConPanel } from '@/features/carriers/components/RateConPanel'
import { CarrierOffersCard } from '@/features/quotes/components/CarrierOffersCard'
import { getCarrierBundle, getTmsSettings } from '@/lib/apiClient'
import { useDrivers } from '@/hooks/useDrivers'
import { netPayable, quickPayFee, quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatCents } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsSelect } from '@/features/tms/kit'
import { DispatchDialog } from './DispatchDialog'
import { RemoveCarrierDialog } from './StatusActions'
import { OWN_FLEET_CALENDAR_PATH, OWN_FLEET_DISPATCH_PATH, settlementPathFor } from './ownFleet'
import type { ShipmentActions } from '../useShipmentActions'
import type { CarrierBundle, ShipmentBundle, TmsSettings } from '@/types/tms'

type CarrierDialog = { kind: 'dispatch' } | { kind: 'remove'; outcome: 'BOUNCED' | 'TONU' } | null

export function CarrierSection({ bundle, actions }: {
  bundle: ShipmentBundle
  actions: ShipmentActions
}) {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [carrierBundle, setCarrierBundle] = useState<CarrierBundle | null>(null)
  const [dialog, setDialog] = useState<CarrierDialog>(null)
  const { drivers } = useDrivers()

  const load = bundle.loads[0]
  const loadCarrier = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const carrierId = loadCarrier?.carrierId ?? null

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    getTmsSettings().catch(() => null).then((s) => { if (live) setSettings(s) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    let live = true
    const answer = carrierId ? getCarrierBundle(carrierId).catch(() => null) : Promise.resolve(null)
    answer.then((b) => { if (live) setCarrierBundle(b) })
    return () => { live = false }
  }, [carrierId])

  // The offers come before the assignment on purpose: that is the order the work
  // happens in, and a load with nobody on it is exactly when the buy side matters.
  const offers = <CarrierOffersCard bundle={bundle} onReload={actions.reload} />

  if (!loadCarrier) {
    return (
      <div className="space-y-4">
        {offers}
        <p className="tms-muted text-sm">Nobody is on this load yet. Book a carrier from the Overview tab.</p>
      </div>
    )
  }

  const isOwnAsset = loadCarrier.kind === 'OWN_ASSET'
  const driver = loadCarrier.driverId ? drivers.find((d) => d.id === loadCarrier.driverId) ?? null : null
  const tiers = quickPayTiersOf(settings)
  const rateCents = loadCarrier.carrierRateCents ?? 0
  const tier = loadCarrier.quickPayDays ? tierFor(loadCarrier.quickPayDays, tiers) : null
  const feeCents = loadCarrier.quickPayFeeCents ?? (tier ? quickPayFee(rateCents, tier.feeBps) : null)

  return (
    <div className="space-y-4">
      {offers}

      <TmsCard
        title={
          <span className="flex items-center gap-2">
            {isOwnAsset ? <Truck size={14} /> : <Building2 size={14} />}
            {isOwnAsset ? loadCarrier.driverName ?? 'Own asset' : loadCarrier.carrierName ?? 'Carrier'}
          </span>
        }
        actions={
          <>
            {loadCarrier.carrierMc && <TmsBadge tone="gray">MC {loadCarrier.carrierMc}</TmsBadge>}
            {loadCarrier.dispatchedAt && <TmsBadge tone="blue">Dispatched</TmsBadge>}
          </>
        }
      >
        <dl className="tms-grid tms-grid-3 text-sm">
          <Fact label="Rate" value={`$${formatCents(rateCents)}`} />
          <Fact label="Terms" value={loadCarrier.paymentTermsDays != null ? `${loadCarrier.paymentTermsDays} days` : '—'} />
          <Fact label="Booked" value={loadCarrier.bookedAt ? formatDateTime(loadCarrier.bookedAt) : '—'} />
          <Fact label="Dispatcher" value={loadCarrier.dispatcherName ?? '—'} />
          <Fact label="Driver" value={[loadCarrier.driverName, loadCarrier.driverPhone].filter(Boolean).join(' · ') || '—'} />
          <Fact label="Truck" value={loadCarrier.truckNumber || '—'} />
          <Fact label="Trailer" value={loadCarrier.trailerNumber || '—'} />
        </dl>
        {(loadCarrier.bookingWarnings?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {loadCarrier.bookingWarnings?.map((w) => <TmsBadge key={w} tone="orange">{w}</TmsBadge>)}
          </div>
        )}
        {isOwnAsset && (
          <p className="mt-3 text-sm" data-testid="own-fleet-links">
            On the <Link to={OWN_FLEET_CALENDAR_PATH} className="underline underline-offset-2">calendar</Link>
            {' · '}in <Link to={OWN_FLEET_DISPATCH_PATH} className="underline underline-offset-2">Dispatch</Link>
            {' · '}pays through{' '}
            <Link to={settlementPathFor(driver?.fleetGroup)} className="underline underline-offset-2" data-testid="own-fleet-settlement">
              driver settlements
            </Link>
          </p>
        )}
      </TmsCard>

      {!isOwnAsset && (
        <TmsCard title="Quick pay">
          <div className="flex flex-wrap items-end gap-3">
            <TmsField label="Term" className="min-w-48">
              <TmsSelect
                aria-label="Quick pay term"
                value={loadCarrier.quickPayDays != null ? String(loadCarrier.quickPayDays) : ''}
                onChange={(e) => {
                  void actions.setQuickPay({
                    loadCarrierId: loadCarrier.id,
                    quickPayDays: e.target.value ? Number(e.target.value) : null,
                  }).catch(() => { /* already reported */ })
                }}
                disabled={actions.busy}
              >
                <option value="">— standard terms —</option>
                {tiers.map((t) => (
                  <option key={t.days} value={String(t.days)}>{t.days} day · {(t.feeBps / 100).toFixed(2)}%</option>
                ))}
              </TmsSelect>
            </TmsField>
            {feeCents != null && (
              <p className="tms-muted text-sm">
                Fee ${formatCents(feeCents)} · net payable ${formatCents(netPayable(rateCents, feeCents))}
              </p>
            )}
          </div>
        </TmsCard>
      )}

      {!isOwnAsset && (
        <RateConPanel
          bundle={bundle}
          loadCarrier={loadCarrier}
          carrier={carrierBundle?.carrier ?? null}
          contacts={carrierBundle?.contacts ?? []}
          settings={settings}
          busy={actions.busy}
          onSend={actions.sendRateCon}
          onVoid={actions.voidRateCon}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {load?.status === 'BOOKED' && (
          <TmsButton variant="primary" size="sm" onClick={() => setDialog({ kind: 'dispatch' })} disabled={actions.busy}>
            <Send size={14} className="mr-1" />Dispatch
          </TmsButton>
        )}
        <TmsButton size="sm" onClick={() => setDialog({ kind: 'remove', outcome: 'BOUNCED' })} disabled={actions.busy}>
          <UserMinus size={14} className="mr-1" />Bounce
        </TmsButton>
        <TmsButton size="sm" onClick={() => setDialog({ kind: 'remove', outcome: 'TONU' })} disabled={actions.busy}>
          <UserMinus size={14} className="mr-1" />TONU
        </TmsButton>
      </div>

      {dialog?.kind === 'dispatch' && (
        <DispatchDialog
          loadCarrier={loadCarrier}
          busy={actions.busy}
          onClose={() => setDialog(null)}
          onConfirm={(input) => { void actions.dispatchLoad(input).then(() => setDialog(null)).catch(() => {}) }}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveCarrierDialog
          outcome={dialog.outcome}
          loadCarrier={loadCarrier}
          busy={actions.busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason, note) => {
            void actions.load.onRemoveCarrier(loadCarrier.id, dialog.outcome, reason, note)
              .then(() => setDialog(null))
              .catch(() => { /* already reported */ })
          }}
        />
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="tms-field-label">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
