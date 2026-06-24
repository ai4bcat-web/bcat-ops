import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listAmazonTrips, createAmazonTrip, updateAmazonTrip, deleteAmazonTrip,
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting,
  listDriverPayDeductions, createDriverPayDeduction, deleteDriverPayDeduction,
  type AmazonTrip, type DriverPaySetting, type DriverPayDeduction, type FixedExpense, type FuelTransaction,
} from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { calcDriverPay, type DriverPayStatement, type PayDeductionInput } from '@/lib/driverPay'
import { matchedFuelForCard, sumFuel, normalizeCard } from '@/lib/driverFuel'
import { compareByOrder } from '@/lib/calendarOrder'
import type { Driver } from '@/types'

export type { AmazonTrip, DriverPaySetting, DriverPayDeduction, FixedExpense, FuelTransaction }
export { normalizeCard }

/** Inclusive 7-day window from a period start (YYYY-MM-DD). */
export function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

export interface DriverPayRow {
  driver:     Driver
  setting:    DriverPaySetting
  trips:      AmazonTrip[]
  fuel:       number
  fuelTxns:   FuelTransaction[]      // the individual fuel lines that make up `fuel`
  deductions: PayDeductionInput[]   // fixed + fuel + one-offs, in display order
  oneOffs:    DriverPayDeduction[]
  statement:  DriverPayStatement
  /** Ids of this week's trips whose Load ID also appears in the previous week (likely a duplicate import). */
  duplicateTripIds: Set<string>
}

export interface AmazonPayState {
  loading:     boolean
  error:       string | null
  rows:        DriverPayRow[]
  /** Trips filed in the current pay week (across all drivers). */
  tripCount:   number
  /** Drivers that don't yet have a pay setting (so you can configure them). */
  unconfigured: Driver[]
  refresh:     () => void
  // mutations
  addTrip:        (input: Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateTrip:     (id: string, patch: Partial<Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  removeTrip:     (id: string) => Promise<void>
  /** Delete every trip in the current pay week. Returns how many were removed. */
  clearWeek:      () => Promise<number>
  saveSetting:    (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>) => Promise<void>
  addDeduction:   (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction:(id: string) => Promise<void>
}

/** Composes the Amazon weekly pay statements for one 7-day period. */
export function useAmazonPay(periodStart: string): AmazonPayState {
  const { drivers } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips]           = useState<AmazonTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, s, d] = await Promise.all([listAmazonTrips(), listDriverPaySettings(), listDriverPayDeductions()])
      setTrips(t); setSettings(s); setDeductions(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const end = periodEnd(periodStart)

  // Start of the previous pay week — used to flag duplicate trips re-imported from it.
  const prevStart = useMemo(() => {
    const d = new Date(`${periodStart}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 7)
    return d.toISOString().slice(0, 10)
  }, [periodStart])

  const rows = useMemo<DriverPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    return settings
      .filter((s) => (s.payGroup ?? 'AMAZON') === 'AMAZON' && s.active !== false)
      .map((setting): DriverPayRow | null => {
        const driver = driverById.get(setting.driverId)
        if (!driver) return null

        const driverTrips = trips
          .filter((t) => t.driverId === setting.driverId && t.periodStart === periodStart)
          .sort(compareByOrder((t) => t.sortOrder, (t) => t.createdAt))

        // Load IDs this driver ran last week → flag any that reappear this week.
        const prevLoadIds = new Set(
          trips.filter((t) => t.driverId === setting.driverId && t.periodStart === prevStart && t.loadId)
            .map((t) => t.loadId as string),
        )
        const duplicateTripIds = new Set(
          driverTrips.filter((t) => t.loadId && prevLoadIds.has(t.loadId)).map((t) => t.id),
        )

        // Fuel pulled live from the driver's EFS card for this 7-day window —
        // real fuel only, de-duplicated, itemized (see matchedFuelForCard).
        const fuelTxns = matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end)
        const fuel = sumFuel(fuelTxns)

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const ded: PayDeductionInput[] = [
          ...(setting.fixedExpenses ?? []).map((f) => ({ label: f.label, amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const statement = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
          ded,
        )

        return { driver, setting, trips: driverTrips, fuel, fuelTxns, deductions: ded, oneOffs, statement, duplicateTripIds }
      })
      .filter((r): r is DriverPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, trips, deductions, fuelTxs, periodStart, prevStart, end])

  const tripCount = useMemo(() => trips.filter((t) => t.periodStart === periodStart).length, [trips, periodStart])

  const unconfigured = useMemo(() => {
    const configured = new Set(settings.map((s) => s.driverId))
    return drivers.filter((d) => d.active !== false && !configured.has(d.id))
  }, [drivers, settings])

  // ── Mutations (optimistic refresh) ──────────────────────────────────────────
  const addTrip = useCallback(async (input: Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createAmazonTrip(input)
    setTrips((p) => [...p, created])
  }, [])
  const updateTrip = useCallback(async (id: string, patch: Partial<Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>>) => {
    const updated = await updateAmazonTrip(id, patch)
    setTrips((p) => p.map((t) => t.id === id ? updated : t))
  }, [])
  const removeTrip = useCallback(async (id: string) => {
    await deleteAmazonTrip(id)
    setTrips((p) => p.filter((t) => t.id !== id))
  }, [])
  const clearWeek = useCallback(async () => {
    const ids = trips.filter((t) => t.periodStart === periodStart).map((t) => t.id)
    for (const id of ids) await deleteAmazonTrip(id)
    setTrips((p) => p.filter((t) => t.periodStart !== periodStart))
    return ids.length
  }, [trips, periodStart])
  const saveSetting = useCallback(async (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>) => {
    const existing = settings.find((s) => s.driverId === driverId)
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

  return { loading, error, rows, tripCount, unconfigured, refresh: load, addTrip, updateTrip, removeTrip, clearWeek, saveSetting, addDeduction, removeDeduction }
}
