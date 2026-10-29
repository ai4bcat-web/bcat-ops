/**
 * The body of a shipment, shared by the drawer and the full page: Overview · Stops ·
 * Carrier/Driver · Tracking · Documents · Financials · Invoicing · Carrier Pay ·
 * History. A DRAFT shipment shows the draft editor instead of the tabs, because a draft
 * has nothing to track yet — that is the only shape difference between the two.
 *
 * Step R merged the old Summary and Details tabs into Overview: there is one record and
 * one vocabulary, so the customer's fields and the load's fields are one set of facts
 * with no "Order" heading between them.
 */
import { useContext, useMemo, useState } from 'react'
import { AuthContext } from '@/hooks/useAuth'
import { formatCents } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import { computeFinancials } from '@/lib/shipmentCharges'
import { laneKey3For, laneKeyFor } from '@/lib/laneKey'
import { SHIPMENT_STATUS_LABELS, LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { useDrivers } from '@/hooks/useDrivers'
import { useTrucks } from '@/hooks/useTrucks'
import { LaneHistoryPanel } from '@/features/quotes/components/LaneHistoryPanel'
import { TmsBadge, TmsCard, TmsTabs } from '@/features/tms/kit'
import type { CreditSummary } from '@/lib/customerCredit'
import { StopCards } from './StopCards'
import { FinancialLines } from './FinancialLines'
import { CarrierSection } from './CarrierSection'
import { TrackingSection } from './TrackingSection'
import { DocumentsSection } from './DocumentsSection'
import { DeliveryCard } from './DeliveryCard'
import { ArCard } from './ArCard'
import { ApCard } from './ApCard'
import { DivisionCard } from './DivisionCard'
import { ReleaseGateCard } from './ReleaseGateCard'
import { HistorySection } from './HistorySection'
import { LoadActions } from './StatusActions'
import { DraftOrderEditor } from './DraftOrderEditor'
import { DETAIL_TABS, type DetailTabKey } from './detailTabs'
import type { ShipmentActions } from '../useShipmentActions'
import type {
  ChargeCodeDef, CustomerRecord, LocationRecord, PricingDefaults, RequiredReference, ShipmentBundle,
} from '@/types/tms'

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
  /** Which tab a deep link asked for; Overview when nobody said. */
  initialTab?: DetailTabKey
  actions: ShipmentActions
}

export function ShipmentDetail(props: ShipmentDetailProps) {
  const {
    bundle, customer, locations, catalog, pricing, marginFloorBps, requiredReferences, credit, currentUser,
    isAdmin, initialTab, actions,
  } = props
  const [tab, setTab] = useState<DetailTabKey>(initialTab ?? 'overview')
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()
  const trucks = equipment.filter((e) => e.type === 'truck')
  const trailers = equipment.filter((e) => e.type === 'trailer')

  // Same optional read as `useAuthUser`: the detail renders inside drawers, dialogs and
  // tests that do not always sit under AuthProvider, and the router is the real gate.
  const auth = useContext(AuthContext)
  const canTag = isAdmin || (auth?.isOwner ?? false) || (auth?.hasPageAccess('tms') ?? false)

  const shipment = bundle.shipment
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const voided = Boolean(shipment.voidedAt)
  const activeCarrier = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const totals = useMemo(
    () => computeFinancials(bundle.charges, { miles: load?.miles ?? null }, pricing, marginFloorBps),
    [bundle.charges, load?.miles, pricing, marginFloorBps],
  )

  // Once the order is invoiced the numbers are frozen; the grid stays readable but every
  // input goes away rather than offering a write the Lambda will refuse. A voided
  // shipment is frozen for the same reason: the router refuses every write on it.
  const chargesFrozen = voided || bundle.financials.some((f) => f.frozenAt)

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
      <TmsTabs tabs={DETAIL_TABS.map((t) => ({ key: t.key, label: t.label }))} active={tab} onSelect={(key) => setTab(key as DetailTabKey)} />

      {tab === 'overview' && (
        <div className="space-y-3">
          <TmsCard
            title="Shipment"
            actions={load ? (
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
                voided={voided}
                handlers={actions.load}
                onRateCon={() => setTab('carrier')}
              />
            ) : undefined}
          >
            <dl className="tms-grid tms-grid-3 text-sm">
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
              <Field label="Load number" value={load?.loadNumber ?? '—'} />
              <Field label="Leg" value={load?.leg != null ? String(load.leg) : '—'} />
              <Field label="Assignment" value={load?.assignmentType ?? '—'} />
              <Field label="Equipment" value={order?.equipmentType ?? load?.equipmentType ?? '—'} />
              <Field label="Rate type" value={order?.rateType ?? '—'} />
              <Field label="Tracking" value={load?.trackingProvider ?? '—'} />
              <Field label="Carrier rep" value={load?.carrierRepId ?? '—'} />
              <Field label="Miles" value={load?.miles != null ? String(load.miles) : '—'} />
              <Field label="Revenue" value={`$${formatCents(totals.revenueCents)}`} />
              <Field label="Cost" value={`$${formatCents(totals.costCents)}`} />
              <Field label="Profit" value={`$${formatCents(totals.profitCents)} (${(totals.marginBps / 100).toFixed(1)}%)`} />
            </dl>

            {(order?.references?.length ?? 0) > 0 && (
              <div className="mt-3">
                <p className="tms-field-label">References</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {order?.references?.map((r, i) => (
                    <TmsBadge key={`${r.code}-${i}`} tone="gray">{r.label || r.code}: {r.value}</TmsBadge>
                  ))}
                </div>
              </div>
            )}
            {(order?.freight?.length ?? 0) > 0 && (
              <div className="mt-3">
                <p className="tms-field-label">Freight</p>
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
            {shipment.holdReason && <Note label="On hold" text={shipment.holdReason} />}
            {shipment.cancelReason && <Note label="Canceled" text={shipment.cancelReason} />}
            {shipment.tenderRejectReason && <Note label="Tender rejected" text={shipment.tenderRejectReason} />}
          </TmsCard>

          {activeCarrier && (
            <TmsCard title="Assigned">
              <p className="text-sm font-medium">
                {activeCarrier.kind === 'OWN_ASSET' ? activeCarrier.driverName ?? 'Own asset' : activeCarrier.carrierName ?? 'Carrier'}
              </p>
              <p className="tms-muted text-xs">
                {[activeCarrier.truckNumber && `Truck ${activeCarrier.truckNumber}`, activeCarrier.trailerNumber && `Trailer ${activeCarrier.trailerNumber}`, activeCarrier.driverPhone]
                  .filter(Boolean).join(' · ') || '—'}
              </p>
            </TmsCard>
          )}

          <DeliveryCard bundle={bundle} onReload={actions.reload} />

          <DivisionCard
            shipment={shipment}
            canTag={canTag && !voided}
            busy={actions.busy}
            onSetRevTag={actions.onSetRevTag}
            onClearRevTag={actions.onClearRevTag}
            onSetSalesRep={actions.onSetSalesRep}
          />
        </div>
      )}

      {tab === 'stops' && (
        <StopCards
          stops={load?.stops ?? []}
          locations={locations}
          readOnly={voided || shipment.status === 'CANCELED'}
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
        <>
          <FinancialLines
            charges={bundle.charges}
            catalog={catalog}
            context={{ miles: load?.miles ?? null }}
            pricing={pricing}
            marginFloorBps={marginFloorBps}
            readOnly={chargesFrozen}
            onSave={actions.saveCharges}
          />
          {/* What this lane has paid before, beside what it is being priced at now. */}
          <LaneHistoryPanel
            laneKey={laneKeyFor(load?.stops)}
            laneKey3={laneKey3For(load?.stops)}
            miles={load?.miles ?? null}
            equipmentType={order?.equipmentType ?? null}
            rateType={order?.rateType ?? null}
          />
        </>
      )}

      {tab === 'invoicing' && (
        <div className="space-y-3">
          <ArCard bundle={bundle} onReload={actions.reload} />
          <ReleaseGateCard shipment={shipment} order={order ?? null} />
        </div>
      )}

      {tab === 'carrierPay' && <ApCard bundle={bundle} onReload={actions.reload} />}

      {tab === 'history' && <HistorySection bundle={bundle} />}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="tms-field-label">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}

function Note({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-3 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-2 text-xs">
      <span className="font-medium">{label}: </span>{text}
    </div>
  )
}
