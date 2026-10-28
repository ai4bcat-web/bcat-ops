/**
 * The body of a shipment, shared by the drawer and the full page: Summary · Details ·
 * Stops · Carrier · Tracking · Documents · Financials (spec §6.4 "Board"). A DRAFT shipment
 * shows the draft order editor instead of the tabs, because a draft has nothing to track
 * yet — that is the only shape difference between the two.
 */
import { useMemo, useState } from 'react'
import { Building2, ClipboardList, FileText, MapPin, DollarSign, Info, Radar } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatCents } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import { computeFinancials } from '@/lib/shipmentCharges'
import { SHIPMENT_STATUS_LABELS, LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { useDrivers } from '@/hooks/useDrivers'
import { useTrucks } from '@/hooks/useTrucks'
import type { CreditSummary } from '@/lib/customerCredit'
import { StopCards } from './StopCards'
import { FinancialLines } from './FinancialLines'
import { CarrierSection } from './CarrierSection'
import { TrackingSection } from './TrackingSection'
import { DocumentsSection } from './DocumentsSection'
import { DeliveryCard } from './DeliveryCard'
import { LoadActions } from './StatusActions'
import { DraftOrderEditor } from './DraftOrderEditor'
import type { ShipmentActions } from '../useShipmentActions'
import type {
  ChargeCodeDef, CustomerRecord, LocationRecord, PricingDefaults, RequiredReference, ShipmentBundle,
} from '@/types/tms'

const TABS = [
  { key: 'summary', label: 'Summary', icon: Info },
  { key: 'details', label: 'Details', icon: ClipboardList },
  { key: 'stops', label: 'Stops', icon: MapPin },
  { key: 'carrier', label: 'Carrier', icon: Building2 },
  { key: 'tracking', label: 'Tracking', icon: Radar },
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'financials', label: 'Financials', icon: DollarSign },
] as const

type TabKey = typeof TABS[number]['key']

export interface ShipmentDetailProps {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  locations: LocationRecord[]
  catalog: ChargeCodeDef[]
  pricing: PricingDefaults | null
  marginFloorBps: number | null
  requiredReferences: RequiredReference[]
  credit: CreditSummary | null
  currentUser: string
  isAdmin: boolean
  actions: ShipmentActions
}

export function ShipmentDetail(props: ShipmentDetailProps) {
  const {
    bundle, customer, locations, catalog, pricing, marginFloorBps, requiredReferences, credit, currentUser,
    isAdmin, actions,
  } = props
  const [tab, setTab] = useState<TabKey>('summary')
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()
  const trucks = equipment.filter((e) => e.type === 'truck')
  const trailers = equipment.filter((e) => e.type === 'trailer')

  const shipment = bundle.shipment
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const activeCarrier = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const totals = useMemo(
    () => computeFinancials(bundle.charges, { miles: load?.miles ?? null }, pricing, marginFloorBps),
    [bundle.charges, load?.miles, pricing, marginFloorBps],
  )

  // Once the order is invoiced the numbers are frozen; the grid stays readable but every
  // input goes away rather than offering a write the Lambda will refuse.
  const chargesFrozen = bundle.financials.some((f) => f.frozenAt)

  if (shipment.status === 'DRAFT') {
    return (
      <DraftOrderEditor
        bundle={bundle}
        customer={customer}
        requiredReferences={requiredReferences}
        catalog={catalog}
        pricing={pricing}
        marginFloorBps={marginFloorBps}
        locations={locations}
        credit={credit}
        currentUser={currentUser}
        onSaveForm={actions.saveForm}
        onSubmit={actions.submit}
        onStopAction={actions.stopAction}
        onSaveCharges={actions.saveCharges}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            <t.icon size={14} />{t.label}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Field label="Status" value={SHIPMENT_STATUS_LABELS[shipment.status]} />
            <Field label="Customer" value={shipment.customerName ?? '—'} />
            <Field label="Mode" value={shipment.mode} />
            <Field label="Origin" value={shipment.originCity ?? '—'} />
            <Field label="Destination" value={shipment.destinationCity ?? '—'} />
            <Field label="Pickup" value={shipment.pickupAppt ? formatDateTime(shipment.pickupAppt) : '—'} />
            <Field label="Delivery" value={shipment.deliveryAppt ? formatDateTime(shipment.deliveryAppt) : '—'} />
            <Field label="Load status" value={load?.status ? LOAD_WORKFLOW_STATUS_LABELS[load.status] : '—'} />
            <Field
              label="Last update"
              value={load?.lastKnownAt || load?.lastCheckCallAt
                ? [
                    formatDateTime(load.lastKnownAt ?? load.lastCheckCallAt),
                    [load.lastKnownCity, load.lastKnownState].filter(Boolean).join(', '),
                  ].filter(Boolean).join(' · ')
                : '—'}
            />
            <Field label="Next check call" value={load?.nextCheckCallAt ? formatDateTime(load.nextCheckCallAt) : '—'} />
            <Field label="AR" value={order?.arStatus ?? '—'} />
            <Field label="Revenue" value={`$${formatCents(totals.revenueCents)}`} />
            <Field label="Cost" value={`$${formatCents(totals.costCents)}`} />
            <Field label="Profit" value={`$${formatCents(totals.profitCents)} (${(totals.marginBps / 100).toFixed(1)}%)`} />
          </dl>
          {shipment.holdReason && <Note label="On hold" text={shipment.holdReason} />}
          {shipment.cancelReason && <Note label="Canceled" text={shipment.cancelReason} />}
          {shipment.tenderRejectReason && <Note label="Tender rejected" text={shipment.tenderRejectReason} />}
          {activeCarrier && (
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Assigned</p>
              <p className="font-medium">
                {activeCarrier.kind === 'OWN_ASSET' ? activeCarrier.driverName ?? 'Own asset' : activeCarrier.carrierName ?? 'Carrier'}
              </p>
              <p className="text-xs text-muted-foreground">
                {[activeCarrier.truckNumber && `Truck ${activeCarrier.truckNumber}`, activeCarrier.trailerNumber && `Trailer ${activeCarrier.trailerNumber}`, activeCarrier.driverPhone]
                  .filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
          )}
          <DeliveryCard bundle={bundle} onReload={actions.reload} />
        </div>
      )}

      {tab === 'details' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            {load && (
              <LoadActions
                load={load}
                mode={shipment.mode}
                bundle={bundle}
                activeCarrier={activeCarrier}
                drivers={drivers}
                trucks={trucks}
                trailers={trailers}
                arStatus={order?.arStatus ?? null}
                isAdmin={isAdmin}
                handlers={actions.load}
                onReload={actions.reload}
                onRateCon={() => setTab('carrier')}
              />
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Field label="Load number" value={load?.loadNumber ?? '—'} />
            <Field label="Leg" value={load?.leg != null ? String(load.leg) : '—'} />
            <Field label="Assignment" value={load?.assignmentType ?? '—'} />
            <Field label="Equipment" value={order?.equipmentType ?? load?.equipmentType ?? '—'} />
            <Field label="Rate type" value={order?.rateType ?? '—'} />
            <Field label="Tracking" value={load?.trackingProvider ?? '—'} />
            <Field label="Next check call" value={load?.nextCheckCallAt ? formatDateTime(load.nextCheckCallAt) : '—'} />
            <Field label="Carrier rep" value={load?.carrierRepId ?? '—'} />
            <Field label="Miles" value={load?.miles != null ? String(load.miles) : '—'} />
          </dl>
          {(order?.references?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">References</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {order?.references?.map((r, i) => (
                  <Badge key={`${r.code}-${i}`} variant="outline" className="text-[10px]">{r.label || r.code}: {r.value}</Badge>
                ))}
              </div>
            </div>
          )}
          {(order?.freight?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Freight</p>
              <ul className="mt-1 space-y-1 text-sm">
                {order?.freight?.map((f) => (
                  <li key={f.id}>
                    {f.qty} × {f.handlingUnit.toLowerCase()}{f.description ? ` — ${f.description}` : ''}
                    {f.weightLbs != null ? ` · ${f.weightLbs} lb` : ''}
                    {f.hazmat ? ' · HAZMAT' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {order?.customerNotes && <Note label="Customer notes" text={order.customerNotes} />}
          {order?.internalNotes && <Note label="Internal notes" text={order.internalNotes} />}
        </div>
      )}

      {tab === 'stops' && (
        <StopCards
          stops={load?.stops ?? []}
          locations={locations}
          readOnly={shipment.status === 'CANCELED'}
          onAction={actions.stopAction}
        />
      )}

      {tab === 'carrier' && <CarrierSection bundle={bundle} actions={actions} />}

      {tab === 'tracking' && (
        <TrackingSection bundle={bundle} customer={customer} catalog={catalog} actions={actions} />
      )}

      {tab === 'documents' && (
        <DocumentsSection
          bundle={bundle}
          customer={customer}
          locations={locations}
          catalog={catalog}
          currentUser={currentUser}
          isAdmin={isAdmin}
          onReload={actions.reload}
        />
      )}

      {tab === 'financials' && (
        <FinancialLines
          charges={bundle.charges}
          catalog={catalog}
          context={{ miles: load?.miles ?? null }}
          pricing={pricing}
          marginFloorBps={marginFloorBps}
          readOnly={chargesFrozen}
          onSave={actions.saveCharges}
        />
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}

function Note({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-2 text-xs">
      <span className="font-medium">{label}: </span>{text}
    </div>
  )
}
