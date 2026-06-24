import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listBoxTruckTrips, createBoxTruckTrip, updateBoxTruckTrip, deleteBoxTruckTrip,
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting,
  listDriverPayDeductions, createDriverPayDeduction, deleteDriverPayDeduction,
  type BoxTruckTrip, type DriverPaySetting, type DriverPayDeduction, type FixedExpense, type FuelTransaction,
} from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { useLoads } from './useLoads'
import { calcDriverPay, type DriverPayStatement, type PayDeductionInput } from '@/lib/driverPay'
import { matchedFuelForCard, sumFuel, normalizeCard } from '@/lib/driverFuel'
import { compareByOrder } from '@/lib/calendarOrder'
import { periodEnd } from '@/lib/biweekly'
import type { Driver, Load } from '@/types'

export type { BoxTruckTrip, DriverPaySetting, DriverPayDeduction, FixedExpense, FuelTransaction }
export { normalizeCard }

/**
 * A row in a driver's statement. Two sources:
 *  • 'calendar' — a load the driver DELIVERED in the period (revenue = rate/100,
 *    matching the fleet-profitability model). Read-only; reflects the calendar.
 *  • 'manual'   — a BoxTruckTrip added/imported by hand (editable). One-offs and
 *    anything not on the calendar.
 */
export interface StatementShipment {
  key:         string
  source:      'calendar' | 'manual'
  aljexPro:    string | null   // our Aljex PRO # (calendar loads)
  proNumber:   string | null   // PU # / TMS #
  customer:    string | null
  salesRep:    string | null
  status:      string | null
  grossProfit: number
  loadId?:     string         // calendar source — the Load id
  trip?:       BoxTruckTrip    // manual source — for edit/remove
}

export interface BoxTruckPayRow {
  driver:        Driver
  setting:       DriverPaySetting
  shipments:     StatementShipment[]
  calendarCount: number
  manualCount:   number
  fuel:          number
  fuelTxns:      FuelTransaction[]
  deductions:    PayDeductionInput[]
  oneOffs:       DriverPayDeduction[]
  statement:     DriverPayStatement
}

export interface BoxTruckPayState {
  loading:     boolean
  error:       string | null
  rows:        BoxTruckPayRow[]
  /** Manual shipments filed in the current period (across all box-truck drivers). */
  tripCount:   number
  unconfigured: Driver[]
  refresh:     () => void
  addTrip:        (input: Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateTrip:     (id: string, patch: Partial<Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  removeTrip:     (id: string) => Promise<void>
  /** Delete every MANUAL shipment in the current period. Returns how many were removed. */
  clearPeriod:    () => Promise<number>
  saveSetting:    (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>) => Promise<void>
  addDeduction:   (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction:(id: string) => Promise<void>
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

  // Drivers flagged as brokers/3PL never count — their covered loads aren't box-truck runs.
  const brokerIds = useMemo(
    () => new Set(drivers.filter((d) => d.type === 'broker').map((d) => d.id)),
    [drivers],
  )

  const rows = useMemo<BoxTruckPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    return settings
      .filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false)
      .map((setting): BoxTruckPayRow | null => {
        const driver = driverById.get(setting.driverId)
        if (!driver || brokerIds.has(driver.id)) return null

        // ── Calendar source: loads this driver DELIVERED inside the period ──────
        const calendarShipments: StatementShipment[] = loads
          .filter((l) => l.deliveryDriverId === driver.id && deliveryDate(l) >= periodStart && deliveryDate(l) <= end)
          .map((l) => ({
            key: `cal:${l.id}`,
            source: 'calendar' as const,
            aljexPro: l.aljexId || null,
            proNumber: l.pickupNumber || l.tmsId || null,
            customer: l.customer ?? null,
            salesRep: null,
            status: 'Delivered',
            grossProfit: (l.rate ?? 0) / 100,   // rate is stored in CENTS
            loadId: l.id,
          }))
          .sort((a, b) => (a.proNumber ?? '').localeCompare(b.proNumber ?? ''))

        // ── Manual source: hand-added/imported shipments for this period ────────
        const calendarPros = new Set(calendarShipments.map((s) => s.proNumber).filter(Boolean) as string[])
        const manualShipments: StatementShipment[] = trips
          .filter((t) => t.driverId === setting.driverId && t.periodStart === periodStart)
          // De-dup: a manual row that matches a calendar PRO is the same load — calendar wins.
          .filter((t) => !(t.proNumber && calendarPros.has(t.proNumber)))
          .sort(compareByOrder((t) => t.sortOrder, (t) => t.createdAt))
          .map((t) => ({
            key: `man:${t.id}`,
            source: 'manual' as const,
            aljexPro: null,
            proNumber: t.proNumber ?? null,
            customer: t.customer ?? null,
            salesRep: t.salesRep ?? null,
            status: t.status ?? null,
            grossProfit: t.grossProfit,
            trip: t,
          }))

        const shipments = [...calendarShipments, ...manualShipments]

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
          shipments.map((s) => ({ freightAmount: s.grossProfit, status: s.status })),
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
          ded,
        )

        return {
          driver, setting, shipments,
          calendarCount: calendarShipments.length, manualCount: manualShipments.length,
          fuel, fuelTxns, deductions: ded, oneOffs, statement,
        }
      })
      .filter((r): r is BoxTruckPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, brokerIds, loads, trips, deductions, fuelTxs, periodStart, end])

  const tripCount = useMemo(() => trips.filter((t) => t.periodStart === periodStart).length, [trips, periodStart])

  const unconfigured = useMemo(() => {
    const boxConfigured = new Set(settings.filter((s) => s.payGroup === 'BOX_TRUCK').map((s) => s.driverId))
    return drivers.filter((d) => d.active !== false && d.type !== 'broker' && !boxConfigured.has(d.id))
  }, [drivers, settings])

  // ── Mutations (manual shipments only; calendar rows reflect the loads page) ──
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
