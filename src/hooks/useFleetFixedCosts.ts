import { useCallback, useMemo } from 'react'
import { useExpenseData } from './useExpenseData'
import { useTrucks } from './useTrucks'
import { getFleetExpenses } from '@/lib/expenseAllocation'
import type { ExpenseCategory } from '@/lib/expenseAllocation'
import type { DateRange } from '@/lib/fleetProfitability'

/**
 * Editable, fleet-level fixed monthly costs for the LOCAL (Ivan) fleet — surfaced and
 * edited directly on the Finances page. Each is persisted as a well-known RecurringExpense
 * (auto-created on first edit) allocated SPLIT_EVEN across the LOCAL trucks, so the shared
 * profitability engine already includes them (prorated) in its category rollup. We read
 * each one's exact in-range contribution back via getFleetExpenses so the P&L can break the
 * lumped categories apart (truck-loan vs trailer-loan, trailer-lease, yard-rent).
 */
export type FleetFixedCostKey = 'loanTrailers' | 'trailerLease' | 'yardRent' | 'tolls'

interface FixedCostDef { key: FleetFixedCostKey; name: string; label: string; category: ExpenseCategory }

export const FLEET_FIXED_COSTS: FixedCostDef[] = [
  { key: 'loanTrailers', name: 'Loan Trailers', label: 'Loan — trailers', category: 'FINANCING' },
  { key: 'trailerLease', name: 'Trailer Lease', label: 'Trailer lease',   category: 'LEASE' },
  { key: 'yardRent',     name: 'Yard Rent',     label: 'Yard rent',       category: 'OTHER' },
  { key: 'tolls',        name: 'Tolls',         label: 'Tolls',           category: 'TOLLS' },
]

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function useFleetFixedCosts() {
  const exp = useExpenseData()
  const { equipment } = useTrucks()

  const localTruckIds = useMemo(
    () => equipment.filter((e) => e.type === 'truck' && e.fleetGroup === 'LOCAL').map((e) => e.id),
    [equipment],
  )

  const typeIdFor = useCallback(
    (key: FleetFixedCostKey) => {
      const def = FLEET_FIXED_COSTS.find((d) => d.key === key)!
      return exp.expenseTypes.find((t) => t.name === def.name)?.id
    },
    [exp.expenseTypes],
  )

  /** Current stored monthly amount per key (0 if never set) — drives the editor inputs. */
  const monthlyAmounts = useMemo(() => {
    const out = { loanTrailers: 0, trailerLease: 0, yardRent: 0, tolls: 0 } as Record<FleetFixedCostKey, number>
    for (const def of FLEET_FIXED_COSTS) {
      const typeId = exp.expenseTypes.find((t) => t.name === def.name)?.id
      const rec = typeId ? exp.recurring.find((r) => r.expenseTypeId === typeId && r.active) : undefined
      out[def.key] = rec?.monthlyAmount ?? 0
    }
    return out
  }, [exp.expenseTypes, exp.recurring])

  /** Sum one expense type's projected + prorated contribution to [range] over the LOCAL fleet. */
  const sumTypeOverFleet = useCallback(
    (range: DateRange, typeId: string, category: ExpenseCategory): number => {
      if (localTruckIds.length === 0) return 0
      const allocations = exp.allocations.map((a) => ({ id: a.id, expenseTypeId: a.expenseTypeId, allocationMethod: a.allocationMethod, truckIds: a.truckIds ?? [] }))
      const recurring = exp.recurring
        .filter((r) => r.expenseTypeId === typeId)
        .map((r) => ({ expenseTypeId: r.expenseTypeId, allocationId: r.allocationId, monthlyAmount: r.monthlyAmount, startMonth: r.startMonth, endMonth: r.endMonth, active: r.active }))
      const records = exp.records
        .filter((r) => r.expenseTypeId === typeId)
        .map((r) => ({ expenseTypeId: r.expenseTypeId, allocationId: r.allocationId, amount: r.amount, periodMonth: r.periodMonth, transactionDate: r.transactionDate, directTruckId: r.directTruckId }))
      const byTruck = getFleetExpenses(
        range.start, range.end,
        { fuelTxs: [], records, recurring, allocations, expenseTypes: [{ id: typeId, category }] },
        { prorateMonthly: true },
      )
      return localTruckIds.reduce((s, id) => s + (byTruck[id]?.total ?? 0), 0)
    },
    [exp.allocations, exp.recurring, exp.records, localTruckIds],
  )

  /** Each fixed cost's actual contribution to [range] (projected + prorated by the engine). */
  const contributionInRange = useCallback(
    (range: DateRange): Record<FleetFixedCostKey, number> => {
      const out = { loanTrailers: 0, trailerLease: 0, yardRent: 0, tolls: 0 } as Record<FleetFixedCostKey, number>
      for (const def of FLEET_FIXED_COSTS) {
        const typeId = exp.expenseTypes.find((t) => t.name === def.name)?.id
        if (typeId) out[def.key] = sumTypeOverFleet(range, typeId, def.category)
      }
      return out
    },
    [exp.expenseTypes, sumTypeOverFleet],
  )

  /** The LOCAL fleet's combined per-truck ELD subscription cost for [range]. */
  const eldInRange = useCallback(
    (range: DateRange): number => {
      const eldType = exp.expenseTypes.find((t) => t.name.trim().toLowerCase() === 'eld')
      return eldType ? sumTypeOverFleet(range, eldType.id, 'OTHER') : 0
    },
    [exp.expenseTypes, sumTypeOverFleet],
  )

  /** Upsert a fixed monthly amount (auto-creating its type + fleet allocation on first edit). */
  const setMonthlyAmount = useCallback(
    async (key: FleetFixedCostKey, monthlyAmount: number) => {
      const def = FLEET_FIXED_COSTS.find((d) => d.key === key)!
      let type = exp.expenseTypes.find((t) => t.name === def.name)
      const existing = type ? exp.recurring.find((r) => r.expenseTypeId === type!.id) : undefined
      if (existing) {
        await exp.updateRecur(existing.id, { monthlyAmount, active: true })
      } else {
        if (!type) {
          type = await exp.createType({ name: def.name, category: def.category, defaultEntryMethod: 'FIXED', active: true })
        }
        let alloc = exp.allocations.find((a) => a.expenseTypeId === type!.id)
        if (!alloc) {
          alloc = await exp.createAlloc({ expenseTypeId: type.id, allocationMethod: 'SPLIT_EVEN', truckIds: localTruckIds, notes: 'Fleet-wide monthly cost' })
        }
        await exp.createRecur({ expenseTypeId: type.id, allocationId: alloc.id, monthlyAmount, startMonth: thisMonth(), active: true })
      }
      exp.refresh()
    },
    [exp, localTruckIds],
  )

  return { monthlyAmounts, contributionInRange, eldInRange, setMonthlyAmount, typeIdFor }
}
