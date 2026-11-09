/**
 * Adapters from the shapes the app already holds (a loaded shipment bundle, a Shipments board row) to
 * the pure `deliveryPhase` input. No reads of their own: they only re-shape what is on the record.
 */
import type { PhaseInput, PhaseStop } from '@/lib/deliveryPhase'
import type { Stop } from '@/types'
import type { LoadCarrierRecord, ShipmentBundle, ShipmentStatus } from '@/types/tms'
import type { ShipmentRow } from './shipmentViews'

function stopsOf(stops: readonly Stop[] | null | undefined): PhaseStop[] {
  return [...(stops ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => ({
      id: s.id,
      type: s.type === 'delivery' ? 'delivery' : 'pickup',
      arrivedAt: s.arrivedAt, departedAt: s.departedAt, appt: s.appt, apptEnd: s.apptEnd, apptType: s.apptType, etaAt: s.etaAt, name: s.name,
    }))
}

/** The live carriers a legs-aware phase reads; one carrier needs no legs, so it is left out. */
function liveCarriersOf(carriers: readonly LoadCarrierRecord[]): PhaseInput['carriers'] {
  const live = carriers.filter((c) => c.status === 'ACTIVE').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  return live.length >= 2 ? live.map((c) => ({ name: c.carrierName, legStopIds: c.legStopIds })) : undefined
}

export function phaseInputOfBundle(bundle: ShipmentBundle | null, nowMs: number): PhaseInput {
  if (!bundle) return { create: true, covered: false, stops: [], nowMs }
  const { shipment } = bundle
  const load = bundle.loads[0]
  const place = [load?.lastKnownCity, load?.lastKnownState].filter(Boolean).join(', ')
  return {
    voided: Boolean(shipment.voidedAt ?? shipment.deletedAt),
    status: shipment.status as ShipmentStatus,
    covered: bundle.loadCarriers.some((c) => c.status === 'ACTIVE'),
    assignment: bundle.loadCarriers.find((c) => c.status === 'ACTIVE')?.assignmentStatus ?? null,
    deliveredAt: shipment.deliveredAt ?? load?.deliveredAt,
    stops: stopsOf(load?.stops),
    carriers: liveCarriersOf(bundle.loadCarriers.filter((c) => c.loadId === load?.id)),
    lastFix: load?.lastKnownAt ? { at: load.lastKnownAt, place: place || null } : null,
    openIncidents: load?.openIncidentCount,
    nowMs,
  }
}

/** A board row carries the stop projection and status the board already reads; limits: no tracking ETA, no live fix beyond `lastKnownAt`. */
export function phaseInputOfRow(row: ShipmentRow, nowMs: number): PhaseInput {
  const place = [row.lastKnownCity, row.lastKnownState].filter(Boolean).join(', ')
  return {
    voided: Boolean(row.voidedAt ?? row.deletedAt),
    status: row.status,
    // An open load (NEED_TO_COVER) is not covered; a carrier or our own truck on it is.
    covered: Boolean(row.carrierAssignmentStatus) || row.assignmentType === 'CARRIER' || row.assignmentType === 'OWN_ASSET',
    assignment: row.carrierAssignmentStatus ?? null,
    deliveredAt: row.deliveredAt,
    stops: stopsOf(row.stops),
    lastFix: row.lastKnownAt ? { at: row.lastKnownAt, place: place || null } : null,
    openIncidents: row.openIncidentCount,
    nowMs,
  }
}
