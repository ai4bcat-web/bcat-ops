/**
 * Step AK — the one place the server decides which number a driver is texted on.
 *
 * Every driver-SMS send (check-call agent, POD request, TEXT_DRIVER, tracking link, the
 * composer) resolves through here: the truck's work phone first, the driver's personal
 * number as the fallback, then the customer / shipment `driverSms` override. A missing
 * table or lookup behaves exactly as before the feature: the leg's snapshot number.
 */
import { effectiveTrackingPrefs } from '../../../src/lib/trackingPrefs'
import {
  driverSmsTarget,
  workPhoneFor,
  type DriverPhoneRecord,
  type SmsTarget,
  type TruckPhoneRecord,
} from '../../../src/lib/workPhone'
import { optionalString } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'

export interface DriverPhoneDeps {
  getById(table: string, id: string): Promise<Row | null>
  /** TruckConfig is keyed by `truckId`, not `id`. Absent (unit tests, legacy env) = no work phones. */
  getTruckConfig?(truckId: string): Promise<Row | null>
  tables: { driver?: string; customer: string }
}

async function safe<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch {
    // A failed phone lookup must never stop a send: fall back to the snapshot number.
    return null
  }
}

export async function resolveDriverSms(
  deps: DriverPhoneDeps,
  i: { carrier: Row | null; shipment: Row; customer: Row | null; load?: Row | null },
): Promise<SmsTarget> {
  const { carrier, shipment, customer, load } = i
  const driverId = optionalString(carrier?.driverId, 100)
  const driverRow = driverId && deps.tables.driver ? await safe(() => deps.getById(deps.tables.driver as string, driverId)) : null
  const driver: DriverPhoneRecord | null = driverRow
    ? { phone: optionalString(driverRow.phone, 40), assignedTruckId: optionalString(driverRow.assignedTruckId, 100) }
    : null

  const loadTruckId = optionalString(carrier?.truckId, 100) ?? optionalString(load?.truckId, 100)
  const truckId = loadTruckId || driver?.assignedTruckId || null
  const configRow = truckId && deps.getTruckConfig ? await safe(() => (deps.getTruckConfig as (id: string) => Promise<Row | null>)(truckId)) : null
  const config: TruckPhoneRecord | null = configRow
    ? {
        truckId: String(configRow.truckId ?? truckId),
        unitNumber: optionalString(configRow.unitNumber, 40),
        phone: optionalString(configRow.phone, 40),
        phoneLabel: optionalString(configRow.phoneLabel, 100),
      }
    : null

  const phones = workPhoneFor({
    driver,
    loadTruckId,
    legDriverPhone: optionalString(carrier?.driverPhone, 40),
    truck: (id) => (config && config.truckId === id ? config : null),
    unitNumber: optionalString(carrier?.truckNumber, 40),
  })
  return driverSmsTarget(phones, effectiveTrackingPrefs({ shipment, customer, loadCarrier: carrier }).driverSms)
}

/** Same, for callers that only hold a leg: loads the shipment's customer and the load's truck itself. */
export async function resolveDriverSmsForLeg(
  deps: DriverPhoneDeps & { tables: { shipment: string; load: string; customer: string; driver?: string } },
  i: { carrier: Row; shipment?: Row | null },
): Promise<SmsTarget> {
  const shipment = i.shipment ?? (await deps.getById(deps.tables.shipment, String(i.carrier.shipmentId)))
  if (!shipment) throw new Error(`Shipment not found: ${String(i.carrier.shipmentId)}`)
  const customerId = optionalString(shipment.customerId, 100)
  const loadId = optionalString(i.carrier.loadId, 100)
  const [customer, load] = await Promise.all([
    customerId && deps.tables.customer ? safe(() => deps.getById(deps.tables.customer, customerId)) : Promise.resolve(null),
    loadId ? safe(() => deps.getById(deps.tables.load, loadId)) : Promise.resolve(null),
  ])
  return resolveDriverSms(deps, { carrier: i.carrier, shipment, customer, load })
}
