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
import { Building2, Plus, Send, Truck, UserCog, UserMinus } from 'lucide-react'
import { RateConPanel } from '@/features/carriers/components/RateConPanel'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { CarrierOffersCard } from '@/features/quotes/components/CarrierOffersCard'
import { getCarrierBundle, getTmsSettings } from '@/lib/apiClient'
import { useDrivers } from '@/hooks/useDrivers'
import { netPayable, quickPayFee, quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatCents } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import { TmsAlert, TmsBadge, TmsButton, TmsCard, TmsField, TmsMetaList, TmsSelect } from '@/features/tms/kit'
import { DispatchDialog } from './DispatchDialog'
import { PostingsSection } from './PostingsSection'
import { CarrierOffersSection } from './CarrierOffersSection'
import { RemoveCarrierDialog } from './StatusActions'
import { OWN_FLEET_CALENDAR_PATH, OWN_FLEET_DISPATCH_PATH, settlementPathFor } from './ownFleet'
import { AssignDriverDialog } from './AssignDriverDialog'
import { distinctStopDrivers } from '@/lib/ownAssetDriver'
import { isCarrierAssignmentStatus } from '@/lib/carrierAssignment'
import { CarrierLadderCard } from './CarrierLadderCard'
import { dispatchBlock } from '../carrierLadder'
import { useTrucks } from '@/hooks/useTrucks'
import { liveCarriersOf } from '@/lib/carrierTotals'
import { MAX_LIVE_CARRIERS, legStopsOf } from '@/lib/carrierLegs'
import type { ShipmentActions } from '../useShipmentActions'
import type { CarrierBundle, LoadCarrierRecord, ShipmentBundle, TmsSettings } from '@/types/tms'
import type { Stop } from '@/types'

const OWN_FLEET_SCHEDULE_PATH = '/schedule'

type CarrierDialog = { kind: 'dispatch' } | { kind: 'assign' } | { kind: 'cover' } | { kind: 'remove'; outcome: 'BOUNCED' | 'TONU' } | null

export function CarrierSection({ bundle, actions, isAdmin = false }: {
  bundle: ShipmentBundle
  actions: ShipmentActions
  /** Owner/ADMIN may change the driver on a load in a closed pay week, with a reason. */
  isAdmin?: boolean
}) {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [dialog, setDialog] = useState<CarrierDialog>(null)
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()

  const load = bundle.loads[0]
  // Every live carrier, in booking order: one block each (AT-plan §6.3). One carrier renders exactly as it always did.
  const liveCarriers = liveCarriersOf(bundle.loadCarriers, load?.id ?? '')
  const loadCarrier = liveCarriers[0] ?? null

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    getTmsSettings().catch(() => null).then((s) => { if (live) setSettings(s) })
    return () => { live = false }
  }, [])

  // The offers come before the assignment on purpose: that is the order the work
  // happens in, and a load with nobody on it is exactly when the buy side matters.
  const offers = <CarrierOffersCard bundle={bundle} onReload={actions.reload} />

  const shipmentId = bundle.shipment.id
  const buildState = bundle.shipment.buildState
  const voided = Boolean(bundle.shipment.voidedAt)
  // Imported Aljex history has no driver and is exempt from Step W (DECIDED-5).
  const legacy = bundle.shipment.legacyImported === true
  const ownAssetNoLeg = load?.assignmentType === 'OWN_ASSET' && !voided && !legacy

  const noDriverBanner = (
    <TmsAlert tone="orange">
      <div data-testid="own-asset-no-driver" className="flex flex-wrap items-center justify-between gap-2">
        <span>
          No driver on this Ivan Cartage load. It will not show on the Schedule or in any settlement until you pick one.
        </span>
        <TmsButton size="sm" variant="primary" onClick={() => setDialog({ kind: 'assign' })} disabled={actions.busy}>
          Assign driver
        </TmsButton>
      </div>
    </TmsAlert>
  )
  const assignDialog = dialog?.kind === 'assign' && load ? (
    <AssignDriverDialog
      load={load} activeLeg={loadCarrier} drivers={drivers}
      trucks={equipment.filter((e) => e.type === 'truck')} trailers={equipment.filter((e) => e.type === 'trailer')}
      isAdmin={isAdmin} busy={actions.busy}
      onClose={() => setDialog(null)}
      onConfirm={actions.load.onAssignAsset}
    />
  ) : null

  // The legs choice and addCarrier live in the Cover dialog, which adds (never replaces) once a carrier is live.
  const coverDialog = dialog?.kind === 'cover' ? (
    <CoverCarrierDialog
      shipmentId={shipmentId}
      shipmentNumber={bundle.shipment.number}
      bundle={bundle}
      onClose={() => setDialog(null)}
      onCovered={() => { void actions.reload() }}
    />
  ) : null

  if (!loadCarrier) {
    return (
      <div className="space-y-4">
        <CarrierOffersSection shipmentId={shipmentId} bundle={bundle} onReload={actions.reload} />
        <PostingsSection shipmentId={shipmentId} loadId={load?.id} buildState={buildState} onReload={actions.reload} />
        {offers}
        {ownAssetNoLeg
          ? noDriverBanner
          : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="tms-muted text-sm">Nobody is on this load yet.</p>
              {!voided && !legacy && (
                <TmsButton variant="primary" size="sm" data-testid="cover-open" onClick={() => setDialog({ kind: 'cover' })} disabled={actions.busy}>
                  Cover
                </TmsButton>
              )}
            </div>
          )}
        {assignDialog}
        {coverDialog}
      </div>
    )
  }

  const multi = liveCarriers.length > 1
  // Own fleet stays exclusive on a load (D2); the cap is four (D7); a delivered or canceled load takes no more.
  const mayAdd = !voided && !legacy && load != null
    && liveCarriers.every((lc) => lc.kind === 'CARRIER')
    && liveCarriers.length < MAX_LIVE_CARRIERS
    && (load.status === 'SOURCING' || load.status === 'BOOKED' || load.status === 'DISPATCHED')

  return (
    <div className="space-y-4">
      <CarrierOffersSection shipmentId={shipmentId} bundle={bundle} onReload={actions.reload} />
      <PostingsSection shipmentId={shipmentId} loadId={load?.id} buildState={buildState} onReload={actions.reload} />
      {offers}

      {liveCarriers.map((lc, index) => (
        multi
          ? (
            <section key={lc.id} className="space-y-4" data-testid="carrier-block" data-load-carrier-id={lc.id}>
              <h3 className="text-sm font-semibold">Carrier {index + 1} · {lc.kind === 'OWN_ASSET' ? lc.driverName ?? 'Own asset' : lc.carrierName ?? 'Carrier'}</h3>
              <CarrierBlock bundle={bundle} actions={actions} loadCarrier={lc} settings={settings} isAdmin={isAdmin} multi />
            </section>
          )
          : <CarrierBlock key={lc.id} bundle={bundle} actions={actions} loadCarrier={lc} settings={settings} isAdmin={isAdmin} multi={false} />
      ))}

      {mayAdd && (
        <div className="flex flex-wrap items-center gap-3">
          <TmsButton size="sm" data-testid="add-carrier-open" onClick={() => setDialog({ kind: 'cover' })} disabled={actions.busy}>
            <Plus size={14} className="mr-1" />Add carrier
          </TmsButton>
        </div>
      )}
      {coverDialog}
    </div>
  )
}

/** One live carrier's booking: the card, the ladder, quick pay, its own rate con, dispatch, bounce and TONU. */
function CarrierBlock({ bundle, actions, loadCarrier, settings, isAdmin, multi }: {
  bundle: ShipmentBundle
  actions: ShipmentActions
  loadCarrier: LoadCarrierRecord
  settings: TmsSettings | null
  isAdmin: boolean
  /** Two or more carriers are live: dispatch and tracking names the one that is rolling. */
  multi: boolean
}) {
  const [carrierBundle, setCarrierBundle] = useState<CarrierBundle | null>(null)
  const [dialog, setDialog] = useState<CarrierDialog>(null)
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()

  const load = bundle.loads[0]
  const carrierId = loadCarrier.carrierId ?? null
  const voided = Boolean(bundle.shipment.voidedAt)
  const legacy = bundle.shipment.legacyImported === true

  useEffect(() => {
    let live = true
    const answer = carrierId ? getCarrierBundle(carrierId).catch(() => null) : Promise.resolve(null)
    answer.then((b) => { if (live) setCarrierBundle(b) })
    return () => { live = false }
  }, [carrierId])

  const noDriverBanner = (
    <TmsAlert tone="orange">
      <div data-testid="own-asset-no-driver" className="flex flex-wrap items-center justify-between gap-2">
        <span>
          No driver on this Ivan Cartage load. It will not show on the Schedule or in any settlement until you pick one.
        </span>
        <TmsButton size="sm" variant="primary" onClick={() => setDialog({ kind: 'assign' })} disabled={actions.busy}>
          Assign driver
        </TmsButton>
      </div>
    </TmsAlert>
  )
  const assignDialog = dialog?.kind === 'assign' && load ? (
    <AssignDriverDialog
      load={load} activeLeg={loadCarrier} drivers={drivers}
      trucks={equipment.filter((e) => e.type === 'truck')} trailers={equipment.filter((e) => e.type === 'trailer')}
      isAdmin={isAdmin} busy={actions.busy}
      onClose={() => setDialog(null)}
      onConfirm={actions.load.onAssignAsset}
    />
  ) : null

  const isOwnAsset = loadCarrier.kind === 'OWN_ASSET'
  const ownAssetNoDriver = isOwnAsset && !loadCarrier.driverId && !legacy
  const driver = loadCarrier.driverId ? drivers.find((d) => d.id === loadCarrier.driverId) ?? null : null
  const localDriver = Boolean(driver) && (!driver?.fleetGroup || driver.fleetGroup === 'LOCAL')
  const stopDriverIds = distinctStopDrivers(load?.stops)
  const relayNames = stopDriverIds.length >= 2 ? stopDriverIds.map((id) => drivers.find((d) => d.id === id)?.name ?? id) : null
  const tiers = quickPayTiersOf(settings)
  const rateCents = loadCarrier.carrierRateCents ?? 0
  const tier = loadCarrier.quickPayDays ? tierFor(loadCarrier.quickPayDays, tiers) : null
  const feeCents = loadCarrier.quickPayFeeCents ?? (tier ? quickPayFee(rateCents, tier.feeBps) : null)
  // Step AM: on the ladder, Dispatch waits for the four driver fields. Tracking keys off that record.
  const driverGate = !isOwnAsset && isCarrierAssignmentStatus(loadCarrier.assignmentStatus) ? dispatchBlock(loadCarrier) : null
  // One carrier: Dispatch is the BOOKED step, as ever. Several: the load goes DISPATCHED with the first, so each
  // carrier that has not rolled yet keeps its own Dispatch button.
  const mayDispatch = load?.status === 'BOOKED' || (multi && load?.status === 'DISPATCHED' && !loadCarrier.dispatchedAt)

  return (
    <div className="space-y-4">
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
        <TmsMetaList
          columns={3}
          items={[
            { label: 'Rate', value: `$${formatCents(rateCents)}` },
            { label: 'Terms', value: loadCarrier.paymentTermsDays != null ? `${loadCarrier.paymentTermsDays} days` : null },
            { label: 'Booked', value: loadCarrier.bookedAt ? formatDateTime(loadCarrier.bookedAt) : null },
            { label: 'Dispatcher', value: loadCarrier.dispatcherName },
            { label: 'Driver', value: [loadCarrier.driverName, loadCarrier.driverPhone].filter(Boolean).join(' · ') },
            { label: 'Truck', value: loadCarrier.truckNumber },
            { label: 'Trailer', value: loadCarrier.trailerNumber },
            ...(multi ? [{ label: 'Legs', value: legsLabel(loadCarrier, load?.stops) }] : []),
          ]}
        />
        {(loadCarrier.bookingWarnings?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {loadCarrier.bookingWarnings?.map((w) => <TmsBadge key={w} tone="orange">{w}</TmsBadge>)}
          </div>
        )}
        {relayNames && (
          <div className="mt-2">
            <TmsBadge tone="blue">Relay: {relayNames.join(' → ')}</TmsBadge>
          </div>
        )}
        {ownAssetNoDriver && noDriverBanner}
        {isOwnAsset && (
          <p className="mt-3 text-sm" data-testid="own-fleet-links">
            On the <Link to={OWN_FLEET_CALENDAR_PATH} className="underline underline-offset-2">calendar</Link>
            {' · '}on the <Link to={OWN_FLEET_SCHEDULE_PATH} className="underline underline-offset-2">Schedule</Link>
            {' · '}in <Link to={OWN_FLEET_DISPATCH_PATH} className="underline underline-offset-2">Dispatch</Link>
            {' · '}
            {localDriver
              ? <Link to={settlementPathFor(driver?.fleetGroup)} className="underline underline-offset-2" data-testid="own-fleet-settlement">paperwork (no settlement)</Link>
              : <>pays through{' '}
                <Link to={settlementPathFor(driver?.fleetGroup)} className="underline underline-offset-2" data-testid="own-fleet-settlement">
                  driver settlements
                </Link></>}
          </p>
        )}
      </TmsCard>

      {!isOwnAsset && (
        <CarrierLadderCard
          bundle={bundle}
          loadCarrier={loadCarrier}
          carrier={carrierBundle?.carrier ?? null}
          actions={actions}
          onRemove={() => setDialog({ kind: 'remove', outcome: 'BOUNCED' })}
        />
      )}

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
        {mayDispatch && (
          <TmsButton
            variant="primary" size="sm" onClick={() => setDialog({ kind: 'dispatch' })}
            disabled={actions.busy || ownAssetNoDriver || driverGate != null}
            title={ownAssetNoDriver ? 'Pick the driver before dispatching' : driverGate ?? undefined}
          >
            <Send size={14} className="mr-1" />Dispatch
          </TmsButton>
        )}
        {isOwnAsset && !voided && !ownAssetNoDriver && (
          <TmsButton size="sm" onClick={() => setDialog({ kind: 'assign' })} disabled={actions.busy}>
            <UserCog size={14} className="mr-1" />{loadCarrier.driverId ? 'Change driver' : 'Assign driver'}
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
          onConfirm={async (input) => {
            await actions.dispatchLoad(multi ? { ...input, loadCarrierId: loadCarrier.id } : input)
            setDialog(null)
          }}
        />
      )}
      {assignDialog}
      {dialog?.kind === 'remove' && (
        <RemoveCarrierDialog
          outcome={dialog.outcome}
          loadCarrier={loadCarrier}
          busy={actions.busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason, note, repostToDat) => {
            void actions.load.onRemoveCarrier(loadCarrier.id, dialog.outcome, reason, note, repostToDat)
              .then(() => setDialog(null))
              .catch(() => { /* already reported */ })
          }}
        />
      )}
    </div>
  )
}

/** "All stops" or the covered stops in route order, e.g. "1. Dallas, 2. Austin". */
function legsLabel(loadCarrier: LoadCarrierRecord, stops: Stop[] | null | undefined): string {
  const covered = legStopsOf(loadCarrier, stops ?? [])
  if (!loadCarrier.legStopIds?.length || covered.length === (stops ?? []).length) return 'All stops'
  return covered.map((s) => `${(stops ?? []).indexOf(s) + 1}. ${s.name ?? s.city ?? s.type}`).join(', ')
}

