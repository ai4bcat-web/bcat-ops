import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listBoxTruckTrips, createBoxTruckTrip, updateBoxTruckTrip, deleteBoxTruckTrip,
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting,
  listDriverPayDeductions, createDriverPayDeduction, deleteDriverPayDeduction,
  listDriverPayCredits, createDriverPayCredit, updateDriverPayCredit, deleteDriverPayCredit,
  type BoxTruckTrip, type DriverPaySetting, type DriverPayDeduction, type DriverPayCredit,
  type DriverPayCreditInput, type FixedExpense, type FuelTransaction,
} from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { useLoads } from './useLoads'
import { calcDriverPay, type DriverPayStatement, type PayDeductionInput } from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { matchedFuelForCard, sumFuel, normalizeCard } from '@/lib/driverFuel'
import { compareByOrder } from '@/lib/calendarOrder'
import { periodEnd, shiftPeriod } from '@/lib/biweekly'
import type { Driver, Load } from '@/types'

export type { BoxTruckTrip, DriverPaySetting, DriverPayDeduction, DriverPayCredit, DriverPayCreditInput, FixedExpense, FuelTransaction }
export { normalizeCard }

export interface BoxTruckPayRow {
  driver:     Driver
  setting:    DriverPaySetting
  trips:      BoxTruckTrip[]   // every shipment row — calendar-sourced (loadId set) or manual
  fuel:       number
  fuelTxns:   FuelTransaction[]
  deductions: PayDeductionInput[]   // fixed + fuel + one-offs, in display order
  oneOffs:    DriverPayDeduction[]
  credits:    DriverPayCredit[]     // extra pay added to the check at 100% (detention, bonus…)
  statement:  DriverPayStatement
  /** Loads the driver delivered this period that aren't yet pulled in (count). */
  unpulledLoadCount: number
}

export interface BoxTruckPayState {
  loading:     boolean
  error:       string | null
  rows:        BoxTruckPayRow[]
  tripCount:   number
  unconfigured: Driver[]
  refresh:     () => void
  /** Materialize a driver's delivered loads for this period into editable rows (idempotent by loadId). Returns # created. */
  pullFromCalendar: (driverId: string) => Promise<number>
  addTrip:        (input: Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateTrip:     (id: string, patch: Partial<Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  removeTrip:     (id: string) => Promise<void>
  /** Move a shipment onto the NEXT pay period (off this check). Returns the target periodStart. */
  pushTripToNextPeriod: (id: string) => Promise<string>
  /** Delete every shipment in the current period. Returns how many were removed. */
  clearPeriod:    () => Promise<number>
  saveSetting:    (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>) => Promise<void>
  addDeduction:   (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction:(id: string) => Promise<void>
  addCredit:      (input: DriverPayCreditInput) => Promise<void>
  updateCredit:   (id: string, patch: Partial<DriverPayCreditInput>) => Promise<void>
  removeCredit:   (id: string) => Promise<void>
}

/** A load's delivery DATE (YYYY-MM-DD), tolerant of full ISO datetimes. */
const deliveryDate = (l: Load) => (l.deliveryAppt ?? '').slice(0, 10)

/** Composes box-truck pay statements for one 14-day (Wed→Tue) period. */
export function useBoxTruckPay(periodStart: string): BoxTruckPayState {
  const { drivers } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()
  const { loads } = useLoads()

  const [trips, setTrips]           = useState<BoxTruckTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [credits, setCredits]       = useState<DriverPayCredit[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, s, d, c] = await Promise.all([listBoxTruckTrips(), listDriverPaySettings(), listDriverPayDeductions(), listDriverPayCredits()])
      setTrips(t); setSettings(s); setDeductions(d); setCredits(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const end = periodEnd(periodStart)

  // Drivers flagged as brokers/3PL never count — their covered loads aren't box-truck runs.
  const brokerIds = useMemo(
    () => new Set(drivers.filter((d) => d.type === 'broker').map((d) => d.id)),
    [drivers],
  )

  /** Loads a driver DELIVERED inside the period (excludes broker-covered). */
  const deliveredLoadsFor = useCallback((driverId: string): Load[] => {
    if (brokerIds.has(driverId)) return []
    return loads.filter((l) => l.deliveryDriverId === driverId && deliveryDate(l) >= periodStart && deliveryDate(l) <= end)
  }, [loads, brokerIds, periodStart, end])

  const rows = useMemo<BoxTruckPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    return settings
      .filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false)
      .map((setting): BoxTruckPayRow | null => {
        const driver = driverById.get(setting.driverId)
        if (!driver || brokerIds.has(driver.id)) return null

        const driverTrips = trips
          .filter((t) => t.driverId === setting.driverId && t.periodStart === periodStart)
          .sort(compareByOrder((t) => t.sortOrder, (t) => t.createdAt))

        // How many delivered loads aren't materialized yet (so the UI can prompt a pull).
        // Scoped to the driver across ALL periods — a load pushed to the next period is
        // already pulled and must not come back when this period is re-pulled.
        const pulledLoadIds = new Set(
          trips.filter((t) => t.driverId === setting.driverId).map((t) => t.loadId).filter(Boolean) as string[],
        )
        const unpulledLoadCount = deliveredLoadsFor(setting.driverId).filter((l) => !pulledLoadIds.has(l.id)).length

        const fuelTxns = matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end)
        const fuel = sumFuel(fuelTxns)

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const ded: PayDeductionInput[] = [
          ...(setting.fixedExpenses ?? []).map((f) => ({ label: f.label, amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const driverCredits = credits
          .filter((c) => c.driverId === setting.driverId && c.periodStart === periodStart)
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.createdAt.localeCompare(b.createdAt))

        // Gross = Σ gross profit. Pay model is the driver's setting (Zak = 50% after expenses).
        // Credits are added to the check in full, after the % model.
        const statement = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.grossProfit, status: t.status })),
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
          ded,
          driverCredits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })),
        )

        return { driver, setting, trips: driverTrips, fuel, fuelTxns, deductions: ded, oneOffs, credits: driverCredits, statement, unpulledLoadCount }
      })
      .filter((r): r is BoxTruckPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, brokerIds, deliveredLoadsFor, trips, deductions, credits, fuelTxs, periodStart, end])

  const tripCount = useMemo(() => trips.filter((t) => t.periodStart === periodStart).length, [trips, periodStart])

  const unconfigured = useMemo(() => {
    const boxConfigured = new Set(settings.filter((s) => s.payGroup === 'BOX_TRUCK').map((s) => s.driverId))
    return drivers.filter((d) => d.active !== false && d.type !== 'broker' && !boxConfigured.has(d.id))
  }, [drivers, settings])

  // ── Mutations (optimistic) ──────────────────────────────────────────────────
  const addTrip = useCallback(async (input: Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createBoxTruckTrip(input)
    setTrips((p) => [...p, created])
  }, [])
  const updateTrip = useCallback(async (id: string, patch: Partial<Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>>) => {
    const updated = await updateBoxTruckTrip(id, patch)
    setTrips((p) => p.map((t) => t.id === id ? updated : t))
  }, [])
  const removeTrip = useCallback(async (id: string) => {
    await deleteBoxTruckTrip(id)
    setTrips((p) => p.filter((t) => t.id !== id))
  }, [])
  const clearPeriod = useCallback(async () => {
    const ids = trips.filter((t) => t.periodStart === periodStart).map((t) => t.id)
    for (const id of ids) await deleteBoxTruckTrip(id)
    setTrips((p) => p.filter((t) => t.periodStart !== periodStart))
    return ids.length
  }, [trips, periodStart])

  // Materialize a driver's delivered loads → editable BoxTruckTrip rows (skip already-pulled by loadId).
  const pullFromCalendar = useCallback(async (driverId: string) => {
    const existing = trips.filter((t) => t.driverId === driverId && t.periodStart === periodStart)
    // Dedup across every period, not just this one — a shipment pushed forward to the
    // next check has already been pulled and must not reappear here.
    const pulledLoadIds = new Set(trips.filter((t) => t.driverId === driverId).map((t) => t.loadId).filter(Boolean) as string[])
    const toCreate = deliveredLoadsFor(driverId).filter((l) => !pulledLoadIds.has(l.id))
    let order = existing.reduce((m, t) => Math.max(m, t.sortOrder ?? 0), 0)
    const created: BoxTruckTrip[] = []
    for (const l of toCreate) {
      const c = await createBoxTruckTrip({
        driverId, periodStart,
        loadId: l.id,
        date: deliveryDate(l),
        aljexPro: l.aljexId || null,
        proNumber: l.pickupNumber || l.tmsId || null,
        customer: l.customer ?? null,
        salesRep: null,
        loadDesc: null,
        customerRate: null,
        carrierCost: null,
        grossProfit: (l.rate ?? 0) / 100,   // rate stored in CENTS
        status: 'Delivered',
        sortOrder: ++order,
      })
      created.push(c)
    }
    if (created.length) setTrips((p) => [...p, ...created])
    return created.length
  }, [trips, periodStart, deliveredLoadsFor])

  const saveSetting = useCallback(async (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>) => {
    const existing = settings.find((s) => s.driverId === driverId && s.payGroup === 'BOX_TRUCK')
    if (existing) {
      const updated = await updateDriverPaySetting(existing.id, patch)
      setSettings((p) => p.map((s) => s.id === existing.id ? updated : s))
    } else {
      const created = await createDriverPaySetting({ driverId, ...patch })
      setSettings((p) => [...p, created])
    }
  }, [settings])
  const addDeduction = useCallback(async (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createDriverPayDeduction(input)
    setDeductions((p) => [...p, created])
  }, [])
  const removeDeduction = useCallback(async (id: string) => {
    await deleteDriverPayDeduction(id)
    setDeductions((p) => p.filter((d) => d.id !== id))
  }, [])

  const addCredit = useCallback(async (input: DriverPayCreditInput) => {
    const created = await createDriverPayCredit(input)
    setCredits((p) => [...p, created])
  }, [])
  const updateCredit = useCallback(async (id: string, patch: Partial<DriverPayCreditInput>) => {
    const updated = await updateDriverPayCredit(id, patch)
    setCredits((p) => p.map((c) => c.id === id ? updated : c))
  }, [])
  const removeCredit = useCallback(async (id: string) => {
    await deleteDriverPayCredit(id)
    setCredits((p) => p.filter((c) => c.id !== id))
  }, [])

  // Move a shipment to the following period — it drops off this settlement and lands at
  // the bottom of the next one. Used when a load shouldn't be paid on the current check.
  const pushTripToNextPeriod = useCallback(async (id: string) => {
    const trip = trips.find((t) => t.id === id)
    if (!trip) throw new Error('That shipment is no longer in this period')
    const target = shiftPeriod(trip.periodStart, 1)
    const lastOrder = trips
      .filter((t) => t.driverId === trip.driverId && t.periodStart === target)
      .reduce((m, t) => Math.max(m, t.sortOrder ?? 0), 0)
    const updated = await updateBoxTruckTrip(id, { periodStart: target, sortOrder: lastOrder + 1 })
    setTrips((p) => p.map((t) => t.id === id ? updated : t))
    return target
  }, [trips])

  return {
    loading, error, rows, tripCount, unconfigured, refresh: load, pullFromCalendar,
    addTrip, updateTrip, removeTrip, pushTripToNextPeriod, clearPeriod, saveSetting,
    addDeduction, removeDeduction, addCredit, updateCredit, removeCredit,
  }
}
