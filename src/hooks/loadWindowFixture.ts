// Shared fixture for the per-hook window-equivalence tests (PERF plan I5): a 14-month Load
// table and the apiClient reads that partition it by pickup month. Must not import the
// store: the tests' vi.mock('@/lib/apiClient') factory loads this file.
import type { Driver, Load } from '@/types'

export const FIXTURE_NOW = '2026-11-04T15:00:00Z'

export const FIXTURE_DRIVERS = [
  { id: 'd-local', name: 'Local Larry', phone: '', active: true, type: 'driver', fleetGroup: 'LOCAL', assignedTruckId: 't1' },
  { id: 'd-box', name: 'Box Bob', phone: '', active: true, type: 'driver', fleetGroup: 'BOX_TRUCK', assignedTruckId: 't2' },
  { id: 'd-oo', name: 'Owner Op', phone: '', active: true, type: 'driver', fleetGroup: 'OWNER_OPERATOR', assignedTruckId: null },
  { id: 'd-broker', name: 'Broker Co', phone: '', active: true, type: 'broker', fleetGroup: null, assignedTruckId: null },
] as unknown as Driver[]

const DRIVER_IDS = ['d-local', 'd-box', 'd-oo', 'd-broker']

function mk(id: string, pickupAppt: string, deliveryAppt: string, over: Partial<Load> = {}): Load {
  const n = id.length + pickupAppt.length
  const load = {
    id, aljexId: id, tmsId: id.toUpperCase(), pickupNumber: id,
    pickupAppt, deliveryAppt, deliveryApptType: 'exact',
    pickupDriverId: 'd-local', deliveryDriverId: 'd-local',
    readyToInvoice: true, truckId: null, rate: 100_000 + n * 1_000, miles: 200 + n,
    customer: n % 2 ? 'ACME' : 'GLOBEX', status: 'DELIVERED',
    originCity: 'Chicago, IL', destinationCity: 'Detroit, MI',
    ...over,
  } as unknown as Load
  // Real facility events, so the deadhead ledger has something to chain.
  const odo = 10_000 + n * 100
  const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
  load.stops = [
    { id: `${id}:pu`, type: 'pickup', appt: pickupAppt, driverId: load.pickupDriverId, sequence: 0, arrivedAt: pickupAppt, departedAt: plus(pickupAppt, 3_600_000), arrivedOdometer: odo, departedOdometer: odo + 1, arrivedTruckId: 't1', departedTruckId: 't1' },
    { id: `${id}:de`, type: 'delivery', appt: deliveryAppt, driverId: load.deliveryDriverId, sequence: 1, arrivedAt: deliveryAppt, departedAt: plus(deliveryAppt, 3_600_000), arrivedOdometer: odo + 200, departedOdometer: odo + 201, arrivedTruckId: 't1', departedTruckId: 't1' },
  ] as Load['stops']
  return load
}

/** 2025-10 … 2026-11 (14 months), plus the boundary cases every window has to survive. */
function build(): Load[] {
  const out: Load[] = []
  const months: string[] = []
  for (let i = 0; i < 14; i++) {
    const idx = 2025 * 12 + 9 + i
    months.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`)
  }
  for (const m of months) {
    ;[['03', '04'], ['11', '12'], ['19', '20'], ['25', '26']].forEach(([p, d], i) => {
      const drv = DRIVER_IDS[(i + Number(m.slice(5))) % 4]
      out.push(mk(`l-${m}-${i}`, `${m}-${p}T15:00:00Z`, `${m}-${d}T18:00:00Z`, {
        pickupDriverId: drv, deliveryDriverId: drv,
        // Older months are long since invoiced; the recent ones are still being worked.
        readyToInvoice: m < '2026-09' || i % 2 === 0,
        status: m >= '2026-11' && i > 1 ? 'IN_TRANSIT' : 'DELIVERED',
      } as Partial<Load>))
    })
  }
  out.push(
    // Picked up in the month BEFORE the range, delivered inside it.
    mk('l-prev-month', '2026-09-30T20:00:00Z', '2026-10-01T15:00:00Z', { deliveryDriverId: 'd-box', pickupDriverId: 'd-box' }),
    mk('l-prev-long', '2026-09-28T14:00:00Z', '2026-10-02T15:00:00Z', { deliveryDriverId: 'd-local', pickupDriverId: 'd-local' }),
    // Picked up the month before, delivered inside the deadhead window: rides along overnight.
    mk('l-onboard', '2026-09-30T20:00:00Z', '2026-10-20T15:00:00Z', { deliveryDriverId: 'd-local', pickupDriverId: 'd-local' }),
    // UTC month edges: 23:30Z on the 31st and 00:30Z on the 1st.
    mk('l-edge-oct', '2026-10-31T23:30:00Z', '2026-11-01T14:00:00Z', { deliveryDriverId: 'd-box', pickupDriverId: 'd-box' }),
    mk('l-edge-nov', '2026-11-01T00:30:00Z', '2026-11-02T14:00:00Z', { deliveryDriverId: 'd-box', pickupDriverId: 'd-box' }),
    mk('l-edge-oo', '2026-10-31T23:30:00Z', '2026-11-01T14:00:00Z', { deliveryDriverId: 'd-oo', pickupDriverId: 'd-oo' }),
    mk('l-prev-oo', '2026-09-30T20:00:00Z', '2026-10-01T15:00:00Z', { deliveryDriverId: 'd-oo', pickupDriverId: 'd-oo' }),
    // Voided inside the range: in no working set.
    mk('l-void', '2026-10-15T15:00:00Z', '2026-10-16T15:00:00Z', { voidedAt: '2026-10-17T00:00:00Z', deliveryDriverId: 'd-local' } as Partial<Load>),
    // Delivered long before any window and never marked ready to invoice: the legacy
    // 'needs invoice' backlog counts it whatever its age.
    mk('l-old-uninvoiced', '2025-11-10T15:00:00Z', '2025-11-11T15:00:00Z', { readyToInvoice: false, deliveryDriverId: 'd-local' } as Partial<Load>),
    // An open load from far outside any window: the store always carries these.
    mk('l-open-old', '2026-01-10T15:00:00Z', '2026-01-11T15:00:00Z', { status: 'IN_TRANSIT', readyToInvoice: false, deliveryDriverId: 'd-local' } as Partial<Load>),
  )
  return out
}

export const FIXTURE_LOADS: Load[] = build()
export const monthOf = (l: Load) => l.pickupAppt.slice(0, 7)
export const isOpen = (l: Load) => !['DELIVERED', 'INVOICING', 'CANCELED'].includes(l.status ?? '')

/** The apiClient reads the store's window fetch uses, answered from the fixture. */
export const fixtureApi = {
  listShipmentIdsByMonths: async (months: readonly string[]) =>
    FIXTURE_LOADS.filter((l) => months.includes(monthOf(l))).map((l) => l.id),
  listLoadsByShipmentIds: async (ids: readonly string[]) =>
    FIXTURE_LOADS.filter((l) => ids.includes(l.id)),
  listOpenLoads: async () => FIXTURE_LOADS.filter(isOpen),
  // Orders still DOCS_NEEDED: every delivered load not yet released (fixture shipment id = load id).
  listDocsNeededOrdersNarrow: async () =>
    FIXTURE_LOADS.filter((l) => !l.readyToInvoice && !isOpen(l))
      .map((l) => ({ id: `o-${l.id}`, shipmentId: l.id, arStatus: 'DOCS_NEEDED', readyToInvoiceAt: null, invoiceId: null })),
}

