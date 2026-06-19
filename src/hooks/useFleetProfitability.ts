import { useMemo } from 'react'
import { useLoads } from './useLoads'
import { useDrivers } from './useDrivers'
import { useTrucks } from './useTrucks'
import { useFuelTransactions } from './useFuelTransactions'
import { useExpenseData } from './useExpenseData'
import { useTruckMileage } from './useTruckMileage'
import { useDriverPay } from './useDriverPay'
import { driverForTruck } from '@/lib/assignments'
import { ORPHAN_UNITS_BY_GROUP, orphanTruckId } from '@/lib/fleetGroups'
import { calcFleetProfitability } from '@/lib/fleetProfitability'
import type { DateRange, MemberTruck, FleetProfitabilityResult } from '@/lib/fleetProfitability'
import type { ExpenseRecordInput, ExpenseTypeRecord } from '@/lib/expenseAllocation'
import { useAppStore } from '@/store/useAppStore'
import type { FleetGroup } from '@/types/equipment'

/** Synthetic expense type used to fold MaintenanceInvoice rows into the engine. */
const MAINT_INVOICE_TYPE_ID = '__maintenance_invoice__'

export interface FleetProfitabilityHookResult {
  data:    FleetProfitabilityResult | null
  members: MemberTruck[]
  loading: boolean
  error:   string | null
  refresh: () => void
}

/**
 * Composes loads, equipment, drivers, fuel, expenses, mileage and driver pay into a
 * weekly profitability roll-up for one fleet group. Membership is driven by
 * Equipment.fleetGroup (source of truth), plus any Motive-only orphan units bridged
 * via ORPHAN_UNITS_BY_GROUP until they get Equipment records.
 */
export function useFleetProfitability(range: DateRange, group: FleetGroup): FleetProfitabilityHookResult {
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()
  const fuel = useFuelTransactions()
  const exp = useExpenseData()
  const mileage = useTruckMileage('DAY')
  const pay = useDriverPay()
  const maintenanceInvoices = useAppStore((s) => s.maintenanceInvoices)

  const loading = fuel.loading || exp.loading || mileage.loading || pay.loading
  const error = fuel.error || exp.error || mileage.error || pay.error || null

  const refresh = useMemo(
    () => () => { fuel.refresh?.(); exp.refresh(); mileage.refresh(); pay.refresh() },
    [fuel, exp, mileage, pay],
  )

  const members = useMemo<MemberTruck[]>(() => {
    // 1. Equipment-backed members — fleetGroup is the source of truth.
    const equipMembers: MemberTruck[] = equipment
      .filter((e) => e.type === 'truck' && e.fleetGroup === group)
      .map((e) => ({
        truckId:      e.id,
        unitNumber:   e.unitNumber,
        driverName:   driverForTruck(e.id, drivers)?.name ?? null,
        hasEquipment: true,
        hasFuelCard:  (e.fuelCardNumbers ?? []).length > 0,
      }))

    // 2. Orphan Motive-only members (no Equipment record / no fuel card yet).
    //    A unit with ANY truck Equipment record is governed by Equipment.fleetGroup
    //    (the source of truth) — never bridge it via the orphan list, not even into a
    //    different group. So exclude every unit that already has an Equipment record,
    //    not just members of the current group (else a unit reassigned to another
    //    fleet would still be force-added here).
    const equipTruckUnits = new Set(
      equipment.filter((e) => e.type === 'truck').map((e) => e.unitNumber),
    )
    const orphanMembers: MemberTruck[] = (ORPHAN_UNITS_BY_GROUP[group] ?? [])
      .filter((unit) => !equipTruckUnits.has(unit))
      .map((unit) => {
        const truckId = orphanTruckId(unit)
        return {
          truckId,
          unitNumber:   unit,
          driverName:   driverForTruck(truckId, drivers)?.name ?? null,
          hasEquipment: false,
          hasFuelCard:  false,
        }
      })

    return [...equipMembers, ...orphanMembers].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber))
  }, [equipment, drivers, group])

  const data = useMemo<FleetProfitabilityResult | null>(() => {
    if (members.length === 0) {
      return { range, trucks: [], rollup: { revenue: 0, miles: 0, fuel: 0, insurance: 0, loan: 0, otherExpenses: 0, driverCost: 0, net: 0, revenuePerMile: null, fuelPerMile: null, categories: { insurance: 0, financing: 0, lease: 0, maintenance: 0, permits: 0, tolls: 0, other: 0 } }, revenueLeakage: { broker: 0, unattributed: 0 } }
    }

    // Fold MaintenanceInvoice rows (amount in CENTS, attributed to the equipment they
    // were logged against) into the engine as DIRECT MAINTENANCE expense records, so
    // repair spend counts toward fleet net. Invoices on non-member equipment (e.g.
    // trailers not allocated to a truck) are dropped by the member filter.
    const expenseRecords: ExpenseRecordInput[] = [
      ...exp.records.map((r) => ({ expenseTypeId: r.expenseTypeId, allocationId: r.allocationId, amount: r.amount, periodMonth: r.periodMonth, transactionDate: r.transactionDate, directTruckId: r.directTruckId })),
      ...maintenanceInvoices
        .filter((inv) => inv.date)
        .map((inv) => ({ expenseTypeId: MAINT_INVOICE_TYPE_ID, allocationId: null, amount: inv.amount / 100, periodMonth: null, transactionDate: inv.date!, directTruckId: inv.equipmentId })),
    ]
    const expenseTypes: ExpenseTypeRecord[] = [
      ...exp.expenseTypes.map((t) => ({ id: t.id, category: t.category })),
      { id: MAINT_INVOICE_TYPE_ID, category: 'MAINTENANCE' },
    ]

    return calcFleetProfitability(
      range,
      members,
      loads.map((l) => ({ truckId: l.truckId, deliveryDriverId: l.deliveryDriverId, rate: l.rate, deliveryAppt: l.deliveryAppt })),
      fuel.transactions.map((t) => ({ truckId: t.truckId, transactionDate: t.transactionDate, amount: t.amount, itemCategory: t.itemCategory ?? '' })),
      expenseRecords,
      exp.recurring.map((r) => ({ expenseTypeId: r.expenseTypeId, allocationId: r.allocationId, monthlyAmount: r.monthlyAmount, startMonth: r.startMonth, endMonth: r.endMonth, active: r.active })),
      exp.allocations.map((a) => ({ id: a.id, expenseTypeId: a.expenseTypeId, allocationMethod: a.allocationMethod, truckIds: a.truckIds ?? [] })),
      expenseTypes,
      mileage.rows.map((m) => ({ truckId: m.truckId, periodStart: m.periodStart, periodType: m.periodType, miles: m.miles })),
      pay.payPeriods.map((p) => ({ driverId: p.driverId, periodStart: p.periodStart, periodEnd: p.periodEnd, grossPay: p.grossPay })),
      drivers.map((d) => ({ driverId: d.id, assignedTruckId: d.assignedTruckId, isBroker: d.type === 'broker' })),
    )
  }, [range, members, loads, fuel.transactions, exp.records, exp.recurring, exp.allocations, exp.expenseTypes, mileage.rows, pay.payPeriods, drivers, maintenanceInvoices])

  return { data, members, loading, error, refresh }
}
