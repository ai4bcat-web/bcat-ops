/**
 * Step AK — the work phone that rides in a truck, and which number a driver is texted on.
 *
 * `TruckConfig.phone` is the phone physically in the truck (US E.164). The driver's own
 * number (`Driver.phone`, or the `LoadCarrier.driverPhone` snapshot) is the personal one.
 * Pure: shared by the Lambdas (every driver-SMS send resolves through `driverSmsTarget`)
 * and the UI (every surface that shows both numbers).
 */
import { toE164Strict } from './dispatch'
import type { DriverSmsTarget } from './trackingPrefs'

export interface TruckPhoneRecord { truckId: string; unitNumber?: string | null; phone?: string | null; phoneLabel?: string | null }
export interface DriverPhoneRecord { phone?: string | null; assignedTruckId?: string | null }

export interface DriverPhones {
  /** The truck the work phone was read from (or would have been). */
  truckId: string | null
  /** TruckConfig.unitNumber, else the caller-supplied unit ("12"). */
  truckNumber: string | null
  /** E.164; null = no truck, or the truck has no (valid) phone. */
  work: { number: string; label: string | null } | null
  /** E.164 when valid, else null. */
  personal: string | null
  /** As stored (legacy non-E.164 numbers still display). */
  personalRaw: string | null
}

/**
 * One truck is chosen and used consistently: the load's truck when the caller knows one,
 * otherwise the driver's assigned truck. A load's truck without a phone does NOT borrow
 * another truck's phone. Personal: `driver.phone`, then the leg snapshot.
 */
export function workPhoneFor(i: {
  driver?: DriverPhoneRecord | null
  loadTruckId?: string | null
  /** Snapshot `LoadCarrier.driverPhone`: the personal fallback for legs with no Driver row (brokered legs). */
  legDriverPhone?: string | null
  truck: (truckId: string) => TruckPhoneRecord | null | undefined
  /** Display unit when TruckConfig has none (LoadCarrier.truckNumber / Equipment.unitNumber). */
  unitNumber?: string | null
}): DriverPhones {
  const truckId = i.loadTruckId || i.driver?.assignedTruckId || null
  const config = truckId ? i.truck(truckId) ?? null : null
  const workNumber = toE164Strict(config?.phone)
  const label = config?.phoneLabel?.trim() || null

  const candidates = [i.driver?.phone, i.legDriverPhone]
  return {
    truckId,
    truckNumber: truckId ? config?.unitNumber || i.unitNumber || null : i.unitNumber || null,
    work: workNumber ? { number: workNumber, label } : null,
    personal: candidates.map((p) => toE164Strict(p)).find((p) => p != null) ?? null,
    personalRaw: candidates.find((p) => p && p.trim()) ?? null,
  }
}

export interface SmsTarget {
  to: string | null
  source: 'WORK' | 'PERSONAL' | 'NONE'
  /** Why a preferred number was not used, or nothing can be sent. Shown in the UI and returned as `smsError`. */
  reason: string | null
  phones: DriverPhones
}

export function driverSmsTarget(phones: DriverPhones, pref: DriverSmsTarget | null): SmsTarget {
  const { work, personal } = phones
  const truck = phones.truckNumber ? `Truck ${phones.truckNumber}` : 'The truck'
  const personalTarget = (reason: string | null): SmsTarget => (
    personal
      ? { to: personal, source: 'PERSONAL', reason, phones }
      : { to: null, source: 'NONE', reason: 'No phone for this driver', phones }
  )
  const mode = pref ?? 'WORK_THEN_PERSONAL'

  if (mode === 'PERSONAL') return personalTarget(null)
  if (work) return { to: work.number, source: 'WORK', reason: null, phones }
  // No usable work phone. Only name a truck when there is one to name; a leg with no truck at
  // all (a brokered carrier) simply has a personal number, exactly as before.
  const hasTruck = phones.truckId != null || phones.truckNumber != null
  if (mode === 'WORK_ONLY') {
    return { to: null, source: 'NONE', reason: hasTruck ? `${truck} has no work phone` : 'No truck assigned, so no work phone', phones }
  }
  return personalTarget(hasTruck ? `${truck} has no work phone — used the driver's personal number` : null)
}

/** Trucks (not trailers, not parked) with no valid `TruckConfig.phone`. A truck with no TruckConfig row counts. */
export function trucksWithoutPhone(i: {
  equipment: ReadonlyArray<{ id: string; unitNumber: string; type: string; active?: boolean; assignedDriverId?: string | null }>
  configs: ReadonlyMap<string, TruckPhoneRecord>
}): Array<{ truckId: string; unitNumber: string; assignedDriverId: string | null }> {
  return i.equipment
    .filter((e) => e.type === 'truck' && e.active !== false && !toE164Strict(i.configs.get(e.id)?.phone))
    .map((e) => ({ truckId: e.id, unitNumber: e.unitNumber, assignedDriverId: e.assignedDriverId ?? null }))
}

/** E.164 for storage, or an error string for the form. Same acceptance as `toE164Strict` (US only), minus letters. */
export function normalizeTruckPhone(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  if (/[A-Za-z]/.test(raw)) return { ok: false, error: 'Phone numbers have digits only' }
  const value = toE164Strict(raw)
  if (!value) return { ok: false, error: 'Enter a US phone number: 10 digits, e.g. (312) 555-0142' }
  return { ok: true, value }
}
