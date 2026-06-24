import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listBoxTruckTrips, createBoxTruckTrip, updateBoxTruckTrip, deleteBoxTruckTrip,
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting,
  listDriverPayDeductions, createDriverPayDeduction, deleteDriverPayDeduction,
  type BoxTruckTrip, type DriverPaySetting, type DriverPayDeduction, type FixedExpense, type FuelTransaction,
} from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { calcDriverPay, type DriverPayStatement, type PayDeductionInput } from '@/lib/driverPay'
import { matchedFuelForCard, sumFuel, normalizeCard } from '@/lib/driverFuel'
import { compareByOrder } from '@/lib/calendarOrder'
import { periodEnd } from '@/lib/biweekly'
import type { Driver } from '@/types'

export type { BoxTruckTrip, DriverPaySetting, DriverPayDeduction, FixedExpense, FuelTransaction }
export { normalizeCard }

export interface BoxTruckPayRow {
  driver:     Driver
  setting:    DriverPaySetting
  trips:      BoxTruckTrip[]
  fuel:       number
  fuelTxns:   FuelTransaction[]
  deductions: PayDeductionInput[]   // fixed + fuel + one-offs, in display order
  oneOffs:    DriverPayDeduction[]
  statement:  DriverPayStatement
}

export interface BoxTruckPayState {
  loading:     boolean
  error:       string | null
  rows:        BoxTruckPayRow[]
  /** Trips filed in the current period (across all box-truck drivers). */
  tripCount:   number
  /** Active drivers that don't yet have a box-truck pay setting. */
  unconfigured: Driver[]
  refresh:     () => void
  addTrip:        (input: Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateTrip:     (id: string, patch: Partial<Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  removeTrip:     (id: string) => Promise<void>
  /** Delete every trip in the current period. Returns how many were removed. */
  clearPeriod:    () => Promise<number>
  saveSetting:    (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>) => Promise<void>
  addDeduction:   (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction:(id: string) => Promise<void>
}

/** Composes box-truck pay statements for one 14-day (Wed→Tue) period. */
export function useBoxTruckPay(periodStart: string): BoxTruckPayState {
  const { drivers } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips]           = useState<BoxTruckTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, s, d] = await Promise.all([listBoxTruckTrips(), listDriverPaySettings(), listDriverPayDeductions()])
      setTrips(t); setSettings(s); setDeductions(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const end = periodEnd(periodStart)

  const rows = useMemo<BoxTruckPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    return settings
      .filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false)
      .map((setting): BoxTruckPayRow | null => {
        const driver = driverById.get(setting.driverId)
        if (!driver) return null

        const driverTrips = trips
          .filter((t) => t.driverId === setting.driverId && t.periodStart === periodStart)
          .sort(compareByOrder((t) => t.sortOrder, (t) => t.createdAt))

        // Fuel pulled live from the driver's EFS card for this 14-day window.
        const fuelTxns = matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end)
        const fuel = sumFuel(fuelTxns)

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const ded: PayDeductionInput[] = [
          ...(setting.fixedExpenses ?? []).map((f) => ({ label: f.label, amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        // Gross = Σ gross profit. Pay model is the driver's setting (Zak = 50% after expenses).
        const statement = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.grossProfit, status: t.status })),
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
          ded,
        )

        return { driver, setting, trips: driverTrips, fuel, fuelTxns, deductions: ded, oneOffs, statement }
      })
      .filter((r): r is BoxTruckPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, trips, deductions, fuelTxs, periodStart, end])

  const tripCount = useMemo(() => trips.filter((t) => t.periodStart === periodStart).length, [trips, periodStart])

  const unconfigured = useMemo(() => {
    const boxConfigured = new Set(settings.filter((s) => s.payGroup === 'BOX_TRUCK').map((s) => s.driverId))
    return drivers.filter((d) => d.active !== false && !boxConfigured.has(d.id))
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

  return { loading, error, rows, tripCount, unconfigured, refresh: load, addTrip, updateTrip, removeTrip, clearPeriod, saveSetting, addDeduction, removeDeduction }
}
