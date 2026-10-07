import { useState, useEffect, useCallback, useMemo } from 'react'
import { ownerOpCarriesWeeklyCharges } from '@/lib/ownerOperatorTrips'
import { sundayOf } from '@/features/driver-pay/week'
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
import { calcDriverPay, factoringFeePctFor, effectivePayRate, effectiveFixedExpenses, fixedExpenseLineLabel, type DriverPayStatement, type PayDeductionInput, type PayDebitInput } from '@/lib/driverPay'
import { matchedFuelForCard, sumFuel, normalizeCard, effectiveFuelCard } from '@/lib/driverFuel'
import { creditLineLabel } from '@/lib/payCredits'
import { duplicateTripIds as dupIdsForWeek } from '@/lib/tripDedup'
import { compareByOrder } from '@/lib/calendarOrder'
import type { Driver } from '@/types'
import { errorText } from '@/lib/errorText'

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
  /** After-split fixed charges — shown on the statement and subtracted in full after the % model. */
  fixedDebits: PayDebitInput[]
  statement:  DriverPayStatement
  /** Ids of this week's trips whose Load ID also appears in the previous week (likely a duplicate import). */
  duplicateTripIds: Set<string>
}

export interface AmazonPayState {
  loading:     boolean
  error:       string | null
  rows:        DriverPayRow[]
  /** Complete loaded history, including drivers hidden from the current statement. */
  allTrips: AmazonTrip[]
  /** Trips filed in the current pay week (across all drivers). */
  tripCount:   number
  /**
   * Most recent pay week that actually has trips, or null when none do. The page opens
   * on the current calendar week, which is empty until that week's trips are imported —
   * every driver then renders deductions-only as a negative check, which reads as "the
   * data is gone" when 16 weeks of it are one click back.
   */
  /** The week actually being shown — equals the requested week, or the resolved default. */
  periodStart: string
  /** Drivers that don't yet have a pay setting (so you can configure them). */
  unconfigured: Driver[]
  refresh:     () => void
  // mutations
  addTrip:        (input: Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateTrip:     (id: string, patch: Partial<Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  removeTrip:     (id: string) => Promise<void>
  /** Delete every trip in the current pay week. Returns how many were removed. */
  clearWeek:      () => Promise<number>
  saveSetting:    (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>, expectedUpdatedAt: string | undefined) => Promise<void>
  addDeduction:   (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction:(id: string) => Promise<void>
  addCredit:      (input: DriverPayCreditInput) => Promise<void>
  updateCredit:   (id: string, patch: Partial<DriverPayCreditInput>) => Promise<void>
  removeCredit:   (id: string) => Promise<void>
}

/** Composes the Amazon weekly pay statements for one 7-day period. */
/**
 * @param requestedWeek A pay-week start, or null to open on the newest week that has
 * trips. The current calendar week is empty until its Relay export is imported, and an
 * empty week renders every driver as a deductions-only negative check — which reads as
 * "the settlement history is gone" while 16 weeks of it sit one click back.
 */
export function useAmazonPay(requestedWeek: string | null): AmazonPayState {
  const { drivers, updateDriver: updateDriverRecord } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips]           = useState<AmazonTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [credits, setCredits]       = useState<DriverPayCredit[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(() =>
    Promise.all([listAmazonTrips(), listDriverPaySettings(), listDriverPayDeductions(), listDriverPayCredits()])
      .then(([t, s, d, c]) => { setTrips(t); setSettings(s); setDeductions(d); setCredits(c); setError(null) })
      .catch((err: unknown) => { setError(errorText(err)) })
      .finally(() => setLoading(false)),
  [])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { void load() }, [load])

  const latestWeekWithTrips = useMemo(() => {
    let best: string | null = null
    for (const t of trips) {
      if (t.periodStart && (best === null || t.periodStart > best)) best = t.periodStart
    }
    return best
  }, [trips])

  const currentWeek = sundayOf()
  const hasTripsThisWeek = trips.some((t) => t.periodStart === currentWeek)
  const periodStart = requestedWeek
    ?? (hasTripsThisWeek || !latestWeekWithTrips ? currentWeek : latestWeekWithTrips)

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
        const duplicateTripIds = dupIdsForWeek(
          driverTrips,
          trips.filter((t) => t.driverId === setting.driverId && t.periodStart === prevStart),
        )

        // From the first owner-operator week the weekly charges move to that statement.
        // They are per driver-week: charging them here as well would deduct one driver's
        // insurance, lease and fuel twice across the two pages.
        const carriesCharges = !ownerOpCarriesWeeklyCharges(periodStart)

        // Fuel pulled live from the driver's EFS card for this 7-day window —
        // real fuel only, de-duplicated, itemized (see matchedFuelForCard).
        const fuelTxns = carriesCharges ? matchedFuelForCard(fuelTxs, effectiveFuelCard(setting, periodStart), periodStart, end) : []
        const fuel = sumFuel(fuelTxns)

        const oneOffs = carriesCharges
          ? deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)
          : []

        const fixed = carriesCharges ? effectiveFixedExpenses(setting.fixedExpenses, periodStart, end) : []
        const fixedDebits: PayDebitInput[] = fixed
          .filter((f) => f.afterPercent)
          .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

        const ded: PayDeductionInput[] = [
          ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${effectiveFuelCard(setting, periodStart) ?? ''})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const mine = credits
          .filter((c) => carriesCharges && c.driverId === setting.driverId && c.periodStart === periodStart)
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.createdAt.localeCompare(b.createdAt))
        // null kind = CREDIT: every row written before debits existed is a credit.
        const driverCredits = mine.filter((c) => (c.kind ?? 'CREDIT') === 'CREDIT')
        const driverDebits  = mine.filter((c) => c.kind === 'DEBIT')

        // Credits are added to the check in full, after the % model — same as box-truck.
        // After-split fixed charges are debits too, so they cost the driver the whole dollar.
        const statement = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
          // Amazon pays the company directly: nothing on this statement is factored.
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent, factoringFeePct: factoringFeePctFor('AMAZON') },
          ded,
          driverCredits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })),
          [...fixedDebits, ...driverDebits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))],
        )

        return { driver, setting, baseSetting, trips: driverTrips, fuel, fuelTxns, deductions: ded, oneOffs, credits: driverCredits, debits: driverDebits, fixedDebits, statement, duplicateTripIds }
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
  const saveSetting = useCallback(async (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>, expectedUpdatedAt: string | undefined) => {
    const existing = settings.find((s) => s.driverId === driverId)
    if (existing) {
      const updated = await updateDriverPaySetting(existing.id, patch, expectedUpdatedAt ?? '')
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

  return { loading, error, rows, allTrips: trips, tripCount, periodStart, unconfigured, refresh, addTrip, updateTrip, removeTrip, clearWeek, saveSetting, addDeduction, removeDeduction, addCredit, updateCredit, removeCredit }
}
