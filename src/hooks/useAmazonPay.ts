import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listAmazonTrips, createAmazonTrip, updateAmazonTrip, deleteAmazonTrip,
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting,
  listDriverPayDeductions, createDriverPayDeduction, deleteDriverPayDeduction,
  listDriverPayCredits, createDriverPayCredit, updateDriverPayCredit, deleteDriverPayCredit,
  type AmazonTrip, type DriverPaySetting, type DriverPayDeduction, type DriverPayCredit,
  type DriverPayCreditInput, type FixedExpense, type FuelTransaction,
} from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { calcDriverPay, effectivePayRate, type DriverPayStatement, type PayDeductionInput } from '@/lib/driverPay'
import { matchedFuelForCard, sumFuel, normalizeCard } from '@/lib/driverFuel'
import { creditLineLabel } from '@/lib/payCredits'
import { compareByOrder } from '@/lib/calendarOrder'
import type { Driver } from '@/types'

export type { AmazonTrip, DriverPaySetting, DriverPayDeduction, DriverPayCredit, DriverPayCreditInput, FixedExpense, FuelTransaction }
export { normalizeCard }

/** Inclusive 7-day window from a period start (YYYY-MM-DD). */
export function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

export interface DriverPayRow {
  driver:     Driver
  /**
   * The pay setting AS IT APPLIES TO THIS WEEK — payPercent/expensesBeforePercent are
   * the effective rate for the viewed period (a pinned rateHistory window when one
   * covers it), so the table, PDF, CSV and email all show the rate the week was
   * actually paid on. Edit rates through `baseSetting`.
   */
  setting:    DriverPaySetting
  /** The stored setting (current base rate) — what the settings modal edits. */
  baseSetting: DriverPaySetting
  trips:      AmazonTrip[]
  fuel:       number
  fuelTxns:   FuelTransaction[]      // the individual fuel lines that make up `fuel`
  deductions: PayDeductionInput[]   // fixed + fuel + one-offs, in display order
  oneOffs:    DriverPayDeduction[]
  /** Extra pay added to the check at 100% (detention, bonus…) — same model as box-truck. */
  credits:    DriverPayCredit[]
  /** Money taken OFF the check at 100%, after the net (cash advance, damage…). */
  debits:     DriverPayCredit[]
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
  addCredit:      (input: DriverPayCreditInput) => Promise<void>
  updateCredit:   (id: string, patch: Partial<DriverPayCreditInput>) => Promise<void>
  removeCredit:   (id: string) => Promise<void>
}

/** Composes the Amazon weekly pay statements for one 7-day period. */
export function useAmazonPay(periodStart: string): AmazonPayState {
  const { drivers, updateDriver: updateDriverRecord } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips]           = useState<AmazonTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [credits, setCredits]       = useState<DriverPayCredit[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, s, d, c] = await Promise.all([listAmazonTrips(), listDriverPaySettings(), listDriverPayDeductions(), listDriverPayCredits()])
      setTrips(t); setSettings(s); setDeductions(d); setCredits(c)
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
      .map((baseSetting): DriverPayRow | null => {
        const driver = driverById.get(baseSetting.driverId)
        if (!driver) return null

        // The rate in force for THIS pay week (pinned window or current base).
        const setting: DriverPaySetting = { ...baseSetting, ...effectivePayRate(baseSetting, periodStart) }

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

        const mine = credits
          .filter((c) => c.driverId === setting.driverId && c.periodStart === periodStart)
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.createdAt.localeCompare(b.createdAt))
        // null kind = CREDIT: every row written before debits existed is a credit.
        const driverCredits = mine.filter((c) => (c.kind ?? 'CREDIT') === 'CREDIT')
        const driverDebits  = mine.filter((c) => c.kind === 'DEBIT')

        // Credits are added to the check in full, after the % model — same as box-truck.
        const statement = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
          ded,
          driverCredits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })),
          driverDebits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })),
        )

        return { driver, setting, baseSetting, trips: driverTrips, fuel, fuelTxns, deductions: ded, oneOffs, credits: driverCredits, debits: driverDebits, statement, duplicateTripIds }
      })
      .filter((r): r is DriverPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, trips, deductions, credits, fuelTxs, periodStart, prevStart, end])

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

    // The driver record and the pay setting each hold an email. If the settlement email
    // is set and the driver record has none, mirror it onto the driver so nobody is
    // asked for the same address twice.
    const driver = drivers.find((d) => d.id === driverId)
    if (patch.email?.trim() && driver && !driver.email?.trim()) {
      try {
        await updateDriverRecord(driverId, { email: patch.email.trim() })
      } catch (err) {
        console.error('[pay] could not mirror the email onto the driver', err)
      }
    }
  }, [settings, drivers, updateDriverRecord])
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

  return { loading, error, rows, tripCount, unconfigured, refresh: load, addTrip, updateTrip, removeTrip, clearWeek, saveSetting, addDeduction, removeDeduction, addCredit, updateCredit, removeCredit }
}
