/**
 * Adapters from the shapes the app already holds (a loaded shipment bundle, a Shipments board row) to
 * the pure `deliveryPhase` input. No reads of their own: they only re-shape what is on the record.
 */
import type { PhaseInput, PhaseStop } from '@/lib/deliveryPhase'
import type { Stop } from '@/types'
import type { ShipmentBundle, ShipmentStatus } from '@/types/tms'
import type { ShipmentRow } from './shipmentViews'

function stopsOf(stops: readonly Stop[] | null | undefined): PhaseStop[] {
  return [...(stops ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => ({
      type: s.type === 'delivery' ? 'delivery' : 'pickup',
      arrivedAt: s.arrivedAt, departedAt: s.departedAt, appt: s.appt, apptEnd: s.apptEnd, apptType: s.apptType, etaAt: s.etaAt, name: s.name,
    }))
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
    deliveredAt: shipment.deliveredAt ?? load?.deliveredAt,
    stops: stopsOf(load?.stops),
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
    covered: Boolean(row.carrierAssignmentStatus) || Boolean(row.assignmentType),
    deliveredAt: row.deliveredAt,
    stops: stopsOf(row.stops),
    lastFix: row.lastKnownAt ? { at: row.lastKnownAt, place: place || null } : null,
    openIncidents: row.openIncidentCount,
    nowMs,
  }
}
