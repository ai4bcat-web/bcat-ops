/**
 * The Carrier tab of a shipment: who is hauling it, what they are being paid, where the
 * rate confirmation got to, and the three things that end a booking — dispatch, bounce,
 * TONU (spec §6.2).
 *
 * Own-fleet assignments land here too, but with none of the carrier paperwork: a driver
 * on our payroll has no rate con to sign and no quick-pay fee to deduct.
 */
import { useEffect, useState } from 'react'
import { Building2, Send, Truck, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { RateConPanel } from '@/features/carriers/components/RateConPanel'
import { getCarrierBundle, getTmsSettings } from '@/lib/apiClient'
import { netPayable, quickPayFee, quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatCents } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import { DispatchDialog } from './DispatchDialog'
import { RemoveCarrierDialog } from './StatusActions'
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

  if (!loadCarrier) {
    return <p className="text-sm text-muted-foreground">Nobody is on this load yet. Book a carrier from the Details tab.</p>
  }

  const isOwnAsset = loadCarrier.kind === 'OWN_ASSET'
  const tiers = quickPayTiersOf(settings)
  const rateCents = loadCarrier.carrierRateCents ?? 0
  const tier = loadCarrier.quickPayDays ? tierFor(loadCarrier.quickPayDays, tiers) : null
  const feeCents = loadCarrier.quickPayFeeCents ?? (tier ? quickPayFee(rateCents, tier.feeBps) : null)

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          {isOwnAsset ? <Truck size={14} className="text-muted-foreground" /> : <Building2 size={14} className="text-muted-foreground" />}
          <p className="text-sm font-medium">
            {isOwnAsset ? loadCarrier.driverName ?? 'Own asset' : loadCarrier.carrierName ?? 'Carrier'}
          </p>
          {loadCarrier.carrierMc && <Badge variant="outline" className="text-[10px]">MC {loadCarrier.carrierMc}</Badge>}
          {loadCarrier.dispatchedAt && <Badge variant="outline" className="text-[10px]">Dispatched</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          <Fact label="Rate" value={`$${formatCents(rateCents)}`} />
          <Fact label="Terms" value={loadCarrier.paymentTermsDays != null ? `${loadCarrier.paymentTermsDays} days` : '—'} />
          <Fact label="Booked" value={loadCarrier.bookedAt ? formatDateTime(loadCarrier.bookedAt) : '—'} />
          <Fact label="Dispatcher" value={loadCarrier.dispatcherName ?? '—'} />
          <Fact label="Driver" value={[loadCarrier.driverName, loadCarrier.driverPhone].filter(Boolean).join(' · ') || '—'} />
          <Fact label="Truck / trailer" value={[loadCarrier.truckNumber, loadCarrier.trailerNumber].filter(Boolean).join(' / ') || '—'} />
        </dl>
        {(loadCarrier.bookingWarnings?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1">
            {loadCarrier.bookingWarnings?.map((w) => (
              <Badge key={w} variant="outline" className="text-[10px]">{w}</Badge>
            ))}
          </div>
        )}
      </div>

      {!isOwnAsset && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Quick pay</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Term</Label>
              <select
                aria-label="Quick pay term"
                value={loadCarrier.quickPayDays != null ? String(loadCarrier.quickPayDays) : ''}
                onChange={(e) => {
                  void actions.setQuickPay({
                    loadCarrierId: loadCarrier.id,
                    quickPayDays: e.target.value ? Number(e.target.value) : null,
                  }).catch(() => { /* already reported */ })
                }}
                disabled={actions.busy}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— standard terms —</option>
                {tiers.map((t) => (
                  <option key={t.days} value={String(t.days)}>{t.days} day · {(t.feeBps / 100).toFixed(2)}%</option>
                ))}
              </select>
            </div>
            {feeCents != null && (
              <p className="text-sm text-muted-foreground">
                Fee ${formatCents(feeCents)} · net payable ${formatCents(netPayable(rateCents, feeCents))}
              </p>
            )}
          </div>
        </div>
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
          <Button size="sm" onClick={() => setDialog({ kind: 'dispatch' })} disabled={actions.busy}>
            <Send size={14} className="mr-1" />Dispatch
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'remove', outcome: 'BOUNCED' })} disabled={actions.busy}>
          <UserMinus size={14} className="mr-1" />Bounce
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'remove', outcome: 'TONU' })} disabled={actions.busy}>
          <UserMinus size={14} className="mr-1" />TONU
        </Button>
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
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
