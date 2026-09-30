import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listLoads,
  listDriverPaySettings,
  listDriverPayDeductions,
  listDriverPayCredits,
  createDriverPaySetting,
  updateDriverPaySetting,
  createDriverPayDeduction,
  deleteDriverPayDeduction,
  createDriverPayCredit,
  updateDriverPayCredit,
  deleteDriverPayCredit,
  type DriverPaySetting,
  type DriverPayDeduction,
  type DriverPayCredit,
  type DriverPayCreditInput,
  type FuelTransaction,
} from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import {
  calcDriverPay,
  effectivePayRate,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  type DriverPayStatement,
  type PayDeductionInput,
  type PayDebitInput,
} from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { matchedFuelForCard, sumFuel } from '@/lib/driverFuel'
import { ownerOpTripsFor, ownerOpWeekAtOrAfterFirst, type OwnerOpTrip, isOwnerOperatorGroup } from '@/lib/ownerOperatorTrips'
import type { Driver, Load } from '@/types'
import { classificationForFleet } from '@/lib/fileHub'

export type { DriverPaySetting, DriverPayDeduction, DriverPayCredit, DriverPayCreditInput, FuelTransaction }
export { ownerOpWeekAtOrAfterFirst }

export interface OwnerOperatorPayRow {
  driver: Driver
  setting: DriverPaySetting
  baseSetting: DriverPaySetting
  trips: OwnerOpTrip[]
  fuel: number
  fuelTxns: FuelTransaction[]
  deductions: PayDeductionInput[]
  oneOffs: DriverPayDeduction[]
  credits: DriverPayCredit[]
  debits: DriverPayCredit[]
  fixedDebits: PayDebitInput[]
  statement: DriverPayStatement
}

export interface OwnerOperatorPayState {
  loading: boolean
  error: string | null
  rows: OwnerOperatorPayRow[]
  unconfigured: Driver[]
  refresh: () => void
  saveSetting: (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>, expectedUpdatedAt: string | undefined) => Promise<void>
  addDeduction: (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction: (id: string) => Promise<void>
  addCredit: (input: DriverPayCreditInput) => Promise<void>
  updateCredit: (id: string, patch: Partial<DriverPayCreditInput>) => Promise<void>
  removeCredit: (id: string) => Promise<void>
}

function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

export function useOwnerOperatorPay(rawPeriodStart: string): OwnerOperatorPayState {
  const periodStart = useMemo(() => ownerOpWeekAtOrAfterFirst(rawPeriodStart), [rawPeriodStart])
  const { drivers, updateDriver } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [loads, setLoads] = useState<Load[]>([])
  const [settings, setSettings] = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [credits, setCredits] = useState<DriverPayCredit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const end = periodEnd(periodStart)

  const load = useCallback(() =>
    Promise.all([
      listLoads(),
      listDriverPaySettings(),
      listDriverPayDeductions(),
      listDriverPayCredits(),
    ])
      .then(([l, s, d, c]) => {
        setLoads(l)
        setSettings(s)
        setDeductions(d)
        setCredits(c)
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => setLoading(false)),
  [])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { void load() }, [load])

  const rows = useMemo<OwnerOperatorPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    return settings
      .filter((s) => isOwnerOperatorGroup(s.payGroup) && s.active !== false)
      .map((baseSetting): OwnerOperatorPayRow | null => {
        const setting: DriverPaySetting = { ...baseSetting, ...effectivePayRate(baseSetting, periodStart) }
        const driver = driverById.get(setting.driverId)
        // 'BROKER COVERED' and friends are pseudo-drivers that carry real loads; paying
        // one would cut a cheque to nobody. Same guard the box-truck hook uses.
        if (!driver || driver.type === 'broker') return null

        const driverTrips = ownerOpTripsFor(loads, setting.driverId, periodStart)

        // The weekly charges — fixed expenses, the fuel card, one-off deductions — are
        // per driver-week, not per page, so exactly ONE statement carries them. The
        // boundary is a fixed date: through Amazon's last week they stay on the Amazon
        // statement and move here afterwards. periodStart is clamped to the first
        // owner-operator week above, so every week rendered here owns its charges.
        const fuelTxns = matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end)
        const fuel = sumFuel(fuelTxns)

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const fixed = effectiveFixedExpenses(setting.fixedExpenses, periodStart, end)
        const fixedDebits: PayDebitInput[] = fixed
          .filter((f) => f.afterPercent)
          .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

        const ded: PayDeductionInput[] = [
          ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const mine = credits
          .filter((c) => c.driverId === setting.driverId && c.periodStart === periodStart)
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.createdAt.localeCompare(b.createdAt))
        const driverCredits = mine.filter((c) => (c.kind ?? 'CREDIT') === 'CREDIT')
        const driverDebits = mine.filter((c) => c.kind === 'DEBIT')

        const statement = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount })),
          setting,
          ded,
          driverCredits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })),
          [...fixedDebits, ...driverDebits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))],
        )

        return { driver, setting, baseSetting, trips: driverTrips, fuel, fuelTxns, deductions: ded, oneOffs, credits: driverCredits, debits: driverDebits, fixedDebits, statement }
      })
      .filter((r): r is OwnerOperatorPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, loads, deductions, credits, fuelTxs, periodStart, end])

  const unconfigured = useMemo(() => {
    const configured = new Set(
      settings.filter((s) => isOwnerOperatorGroup(s.payGroup)).map((s) => s.driverId),
    )
    return drivers.filter(
      (d) => d.active !== false && d.type !== 'broker'
        && (classificationForFleet(d.fleetGroup) === 'OWNER_OPERATOR' || d.driverType === 'OWNER_OPERATOR') && !configured.has(d.id),
    )
  }, [drivers, settings])

  const saveSetting = useCallback(async (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>, expectedUpdatedAt: string | undefined) => {
    const existing = settings.find((s) => s.driverId === driverId && isOwnerOperatorGroup(s.payGroup))
    if (existing) {
      // Keep whatever group the driver is already on. An Amazon driver edited here must
      // STAY on AMAZON, or their whole Amazon settlement history disappears from that page.
      const { payGroup: _ignored, ...rest } = patch
      const updated = await updateDriverPaySetting(existing.id, rest, expectedUpdatedAt ?? '')
      setSettings((p) => p.map((s) => s.id === existing.id ? updated : s))
    } else {
      const created = await createDriverPaySetting({ driverId, ...patch, payGroup: 'OWNER_OPERATOR' })
      setSettings((p) => [...p, created])
    }

    const driver = drivers.find((d) => d.id === driverId)
    if (patch.email?.trim() && driver && !driver.email?.trim()) {
      try {
        await updateDriver(driverId, { email: patch.email.trim() })
      } catch (err) {
        console.error('[owner-operator-pay] could not mirror the email onto the driver', err)
      }
    }
  }, [settings, drivers, updateDriver])

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

  return {
    loading, error, rows, unconfigured, refresh,
    saveSetting, addDeduction, removeDeduction,
    addCredit, updateCredit, removeCredit,
  }
}
