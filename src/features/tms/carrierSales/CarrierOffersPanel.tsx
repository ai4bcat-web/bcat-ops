/**
 * Click-through for a Carrier Sales load: the load's lane, dates and rates, plus its voice and email offers.
 * No offers are recorded against a load yet, so every load shows "No offers yet".
 */
import { TmsDrawer, TmsEmptyState } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import type { OffersTarget } from './offersTarget'
import './carrierOffersPanel.css'

const money = (cents: number | null) => (cents == null ? '—' : formatCents(cents))

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cs-meta">
      <span className="cs-meta-label">{label}</span>
      <span className="cs-meta-value">{children}</span>
    </div>
  )
}

export function CarrierOffersPanel({ target, onClose }: { target: OffersTarget | null; onClose: () => void }) {
  return (
    <TmsDrawer
      open={target != null}
      onOpenChange={(o) => { if (!o) onClose() }}
      size="xl"
      className="cs-offers-drawer"
      title={target ? `Offers · ${target.number}` : 'Offers'}
      description={target ? `${target.origin} → ${target.destination}` : undefined}
    >
      {target && (
        <div className="cs-drawer-body" data-testid="offers-panel">
          <div className="cs-meta-grid">
            <Meta label="PRO">{target.number}</Meta>
            <Meta label="Lane">{target.origin} → {target.destination}</Meta>
            <Meta label="Equipment">{target.equipment}</Meta>
            <Meta label="Pickup">{formatDateTime(target.pickupAt)}</Meta>
            <Meta label="Delivery">{formatDateTime(target.deliveryAt)}</Meta>
            <Meta label="Customer rate">{money(target.customerRateCents)}</Meta>
            <Meta label="Target buy">{money(target.targetBuyCents)}</Meta>
          </div>
          <TmsEmptyState compact title="No offers yet" message="No voice or email offers have come in on this load. Offers from Aiden and the email negotiator will show up here." />
        </div>
      )}
    </TmsDrawer>
  )
}
