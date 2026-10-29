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
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { AuthContext } from '@/hooks/useAuth'
import { formatCents } from '@/lib/tmsDirectory'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import {
  UNRESOLVED_CUSTOMER_LABEL, customerDisplayName, isCustomerUnresolved, unresolvedCustomerMessage,
} from '@/lib/customerResolution'
import { formatDateTime } from '@/lib/date'
import { computeFinancials } from '@/lib/shipmentCharges'
import { laneKey3For, laneKeyFor } from '@/lib/laneKey'
import { SHIPMENT_STATUS_LABELS, LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { useDrivers } from '@/hooks/useDrivers'
import { useTrucks } from '@/hooks/useTrucks'
import { LaneHistoryPanel } from '@/features/quotes/components/LaneHistoryPanel'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsIconButton, TmsSelect, TmsTabs } from '@/features/tms/kit'
import { useIntegrations } from '@/hooks/useIntegrations'
import { runIntegrationStub } from '@/lib/apiClient'
import { PROVIDERS, isApplicable, liveCapabilitiesOf } from '@/lib/integrations/registry'
import { badgeOf } from '@/lib/integrations/health'
import type { Capability, IntegrationRecord, ProviderDescriptor } from '@/lib/integrations/types'
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
  ShipmentRecord,
} from '@/types/tms'

export interface ShipmentDetailProps {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  /** The directory, so a shipment carrying only typed customer text can be linked to a record. */
  customers: CustomerRecord[]
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
    bundle, customer, customers, locations, catalog, pricing, marginFloorBps, requiredReferences, credit,
    currentUser, isAdmin, initialTab, actions,
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
  // LIST_INTEGRATIONS is owner/ADMIN only, the same gate the Integrations tab carries.
  // Anyone else must not even mount the hook: the refused list would read as "every
  // provider is not connected", which is a lie, and would retry every five minutes.
  const canSeeIntegrations = isAdmin || (auth?.isOwner ?? false)

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

  /*
   * A shipment can exist on nothing but the operator's typed customer text — the legacy
   * entrypoints often have nothing else and nothing invents a Customer record. The gates
   * refuse such a shipment outright, so the card says so and carries the only fix, above
   * the draft editor as well as above the tabs: a DRAFT is exactly where it is commonest.
   */
  const unresolvedCustomer = isCustomerUnresolved(shipment) ? (
    <UnresolvedCustomerCard
      shipment={shipment}
      customers={customers}
      frozen={voided}
      onLink={actions.setCustomer}
    />
  ) : null

  if (shipment.status === 'DRAFT') {
    return (
      <div className="space-y-4">
        {unresolvedCustomer}
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
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {unresolvedCustomer}
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
              <Field label="Customer" value={customerDisplayName(shipment)} />
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

          {/*
           * Which providers could touch freight like this one, and what state each is in.
           * Owner/ADMIN only, because the list behind it is; hidden on a voided shipment,
           * where there is nothing left to post, track or factor.
           */}
          {canSeeIntegrations && !voided && (
            <ShipmentIntegrationsCard onOpenTracking={() => setTab('tracking')} />
          )}
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

/** The capabilities a shipment can be on the receiving end of, in the order they happen. */
const SHIPMENT_CAPABILITIES: { key: Capability; label: string }[] = [
  { key: 'post', label: 'Posting' },
  { key: 'quote', label: 'Rating' },
  { key: 'track', label: 'Tracking' },
  { key: 'factor', label: 'Factoring' },
]

/**
 * What every provider could do for freight like this one, and what state it is in.
 *
 * Step J adds no live per-shipment action: a button appears only for a CONNECTED live
 * provider and only where the action already exists elsewhere in the app — Send to
 * Factor on the invoicing page, tracking on this shipment's own Tracking tab. Everything
 * else is a stub, and a stub run goes to `RUN_STUB`, which takes no shipment at all: it
 * reads the descriptor's sample, writes one audit row and touches no business record.
 * The card is collapsed by default, and the caller hides it on a voided shipment.
 */
function ShipmentIntegrationsCard({ onOpenTracking }: { onOpenTracking: () => void }) {
  const { byKey, loading } = useIntegrations()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  const sections = useMemo(
    () => SHIPMENT_CAPABILITIES.map((cap) => ({
      ...cap,
      providers: PROVIDERS.filter((d) => isApplicable(d) && d.capabilities.includes(cap.key)),
    })).filter((s) => s.providers.length > 0),
    [],
  )

  const runStub = async (descriptor: ProviderDescriptor, capability: Capability) => {
    const id = `${descriptor.key}:${capability}`
    setBusy(id)
    try {
      const { result } = await runIntegrationStub(descriptor.key, capability)
      setResults((prev) => ({ ...prev, [id]: result.message }))
    } catch (e) {
      setResults((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : 'The stub run was refused' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <TmsCard
      title="Integrations"
      actions={(
        <TmsIconButton
          shape="plain"
          aria-label={open ? 'Collapse integrations' : 'Expand integrations'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </TmsIconButton>
      )}
    >
      {!open ? (
        <p className="tms-muted text-xs">Which providers could post, rate, track or factor this shipment, and the state each is in.</p>
      ) : loading ? (
        <p className="tms-muted text-xs">Loading…</p>
      ) : (
        <div className="space-y-3">
          {sections.map((section) => (
            <div key={section.key}>
              <p className="tms-field-label">{section.label}</p>
              <ul className="mt-1 space-y-1 text-sm">
                {section.providers.map((d) => (
                  <ProviderRow
                    key={d.key}
                    descriptor={d}
                    capability={section.key}
                    row={byKey[d.key] ?? null}
                    busy={busy === `${d.key}:${section.key}`}
                    result={results[`${d.key}:${section.key}`] ?? null}
                    onRunStub={() => runStub(d, section.key)}
                    onOpenTracking={onOpenTracking}
                  />
                ))}
              </ul>
            </div>
          ))}
          <p className="tms-muted text-xs">
            A stub run makes no call and changes nothing on this shipment — it records that the button was pressed.
          </p>
        </div>
      )}
    </TmsCard>
  )
}

function ProviderRow({ descriptor, capability, row, busy, result, onRunStub, onOpenTracking }: {
  descriptor: ProviderDescriptor
  capability: Capability
  row: IntegrationRecord | null
  busy: boolean
  result: string | null
  onRunStub: () => void
  onOpenTracking: () => void
}) {
  const badge = badgeOf({
    status: row?.status ?? 'NOT_CONNECTED',
    health: row?.health ?? 'UNKNOWN',
    healthReason: row?.healthReason ?? null,
    mode: row?.mode ?? 'STUB',
  })
  /*
   * Three things have to be true before a live control appears, and "the credentials
   * are entered" is only one of them: the capability has to have a real implementation
   * in this repo (`liveCapabilitiesOf` — a Trucker Tools key buys a stub, not tracking),
   * the row has to be connected, and its last check has to have passed. Anything else
   * falls through to Run stub, which is honest about making no call.
   */
  const live = liveCapabilitiesOf(descriptor).includes(capability)
    && row?.status === 'CONNECTED'
    && row.health === 'OK'

  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{descriptor.label}</span>
      <TmsBadge tone={badge.tone}>{badge.label}</TmsBadge>
      {live && capability === 'track' && (
        <TmsButton size="sm" onClick={onOpenTracking}>Open tracking</TmsButton>
      )}
      {live && capability !== 'track' && descriptor.liveLink && (
        <Link className="text-xs underline underline-offset-2" to={descriptor.liveLink.to}>{descriptor.liveLink.label}</Link>
      )}
      {!live && (
        <TmsButton size="sm" disabled={busy} onClick={onRunStub}>
          {busy ? 'Running…' : 'Run stub'}
        </TmsButton>
      )}
      {result && <span className="tms-muted text-xs">{result}</span>}
    </li>
  )
}

/**
 * The one record carrying only typed customer text, and the one move that resolves it.
 *
 * Readiness is `customerId == null` and never status: the backfill sets status from the
 * stop clock, so one of these can arrive already DELIVERED and would otherwise reach AR
 * and die on a customer id that was never there. The copy is `unresolvedCustomerMessage`
 * so the screen says exactly what the Lambda says when it refuses the submit, the
 * invoice or the factoring.
 */
function UnresolvedCustomerCard({ shipment, customers, frozen, onLink }: {
  shipment: ShipmentRecord
  customers: CustomerRecord[]
  /** A voided shipment is refused every write, so it is told, not asked. */
  frozen: boolean
  onLink: (customerId: string) => Promise<void>
}) {
  const [customerId, setCustomerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // SET_SHIPMENT_CUSTOMER runs the same ACTIVE check CREATE_SHIPMENT runs, and dormant
  // is an automatic "no shipment in 90 days" label new freight clears. The server
  // re-checks; this list exists so nobody is offered a name it is going to refuse.
  const now = new Date().toISOString()
  const shippable = customers.filter((c) => {
    const status = effectiveCustomerStatus(c, null, now)
    return status === 'ACTIVE' || status === 'DORMANT'
  })

  return (
    <TmsCard title={UNRESOLVED_CUSTOMER_LABEL}>
      <p className="text-sm" data-testid="unresolved-customer-note">
        {unresolvedCustomerMessage(shipment, 'submitting, invoicing or factoring it')}
      </p>
      {!frozen && (
        <div className="mt-3 flex items-end gap-2">
          <TmsField label="Customer" error={error}>
            <TmsSelect
              aria-label="Customer to link"
              value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setError(null) }}
            >
              <option value="">— select —</option>
              {shippable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsButton
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (!customerId) { setError('Pick a customer.'); return }
              setBusy(true)
              try {
                await onLink(customerId)
              } catch {
                // `useShipmentActions` already toasted the Lambda's own refusal.
                setError('Could not link that customer.')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Linking…' : 'Link customer'}
          </TmsButton>
        </div>
      )}
    </TmsCard>
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
