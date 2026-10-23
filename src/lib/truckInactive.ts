/**
 * Parking a truck: what stops costing money and what does not.
 *
 * A truck taken out of service stops costing insurance — it comes off the policy — so its
 * premium leaves every total. Its plates and ELD usually keep billing: the registration is
 * paid for the year and the ELD contract runs on. Those are still real spend, so they are
 * NOT dropped. They stay on the parked truck, where every expense and P&L view keeps
 * counting them, and they show in a holding area until someone moves them onto the truck
 * that takes over the plates or the ELD unit.
 *
 * Nothing here needs a separate store: a held cost is simply a plates or ELD recurring cost
 * that is still running on a truck marked inactive.
 */
import {
  listExpenseTypes, createAllocation, createRecurringExpense, updateRecurringExpense,
  type ExpenseTypeData, type RecurringExpenseData, type TruckExpenseAllocationData,
} from '@/lib/apiClient'
import { dayBefore } from '@/lib/recurringRevision'
import type { Equipment } from '@/types/equipment'

export type HeldSlot = 'plates' | 'eld'

export interface TruckRunningCost {
  recurring: RecurringExpenseData
  slot: HeldSlot
  typeName: string
  monthlyAmount: number
}

export interface HeldCost extends TruckRunningCost {
  truck: Pick<Equipment, 'id' | 'unitNumber' | 'inactiveSince' | 'fleetGroup'>
}

const monthOf = (iso: string) => iso.slice(0, 7)

/** Plates are PERMITS; the ELD is the OTHER-category type named "ELD" (see truckCosts.ts). */
export function slotForType(type: Pick<ExpenseTypeData, 'category' | 'name'> | undefined): HeldSlot | null {
  if (!type) return null
  if (type.category === 'PERMITS') return 'plates'
  if (type.category === 'OTHER' && type.name.trim().toLowerCase() === 'eld') return 'eld'
  return null
}

/** Still being charged on `day`: active, and not ended before it. */
export function runningOn(r: Pick<RecurringExpenseData, 'active' | 'endDate' | 'endMonth'>, day: string): boolean {
  if (!r.active) return false
  if (r.endDate) return r.endDate >= day
  if (r.endMonth) return r.endMonth.replace(/^(\d{4})-(\d)$/, '$1-0$2') >= monthOf(day)
  return true
}

/** This truck's plates and ELD costs that are still running on `day`. */
export function platesAndEldFor(
  truckId: string,
  day: string,
  recurring: RecurringExpenseData[],
  allocations: TruckExpenseAllocationData[],
  types: ExpenseTypeData[],
): TruckRunningCost[] {
  const allocById = new Map(allocations.map((a) => [a.id, a]))
  const typeById = new Map(types.map((t) => [t.id, t]))
  const out: TruckRunningCost[] = []
  for (const r of recurring) {
    const ids = allocById.get(r.allocationId)?.truckIds ?? []
    if (ids.length !== 1 || ids[0] !== truckId) continue
    if (!runningOn(r, day)) continue
    const type = typeById.get(r.expenseTypeId)
    const slot = slotForType(type)
    if (!slot || !type) continue
    out.push({ recurring: r, slot, typeName: type.name, monthlyAmount: r.monthlyAmount })
  }
  return out
}

/** The holding area: plates/ELD still charged on a truck that is parked. */
export function holdingArea(
  equipment: Equipment[],
  day: string,
  recurring: RecurringExpenseData[],
  allocations: TruckExpenseAllocationData[],
  types: ExpenseTypeData[],
): HeldCost[] {
  return equipment
    .filter((e) => e.type === 'truck' && !e.active)
    .flatMap((truck) => platesAndEldFor(truck.id, day, recurring, allocations, types).map((c) => ({ ...c, truck })))
    .sort((a, b) => a.truck.unitNumber.localeCompare(b.truck.unitNumber, undefined, { numeric: true }) || a.slot.localeCompare(b.slot))
}

/** The patch that stops a recurring cost from `from` on (it was last charged the day before). */
export function stopFromPatch(r: Pick<RecurringExpenseData, 'startDate' | 'startMonth'>, from: string): Partial<RecurringExpenseData> {
  const start = r.startDate ?? `${r.startMonth.replace(/^(\d{4})-(\d)$/, '$1-0$2')}-01`
  // Never charged at all before `from`: it simply never applied.
  if (start >= from) return { active: false }
  const last = dayBefore(from)
  return { endDate: last, endMonth: monthOf(last) }
}

export async function stopCharging(r: RecurringExpenseData, from: string): Promise<void> {
  await updateRecurringExpense(r.id, stopFromPatch(r, from))
}

/**
 * Move a held cost onto another truck from `from`: the parked truck carries it up to the
 * day before, the new truck from that day. Past months keep the truck that really had it.
 */
export async function moveHeldCost(held: HeldCost, to: Pick<Equipment, 'id' | 'unitNumber'>, from: string): Promise<void> {
  const types = await listExpenseTypes()
  if (!types.some((t) => t.id === held.recurring.expenseTypeId)) throw new Error('That cost type no longer exists')
  const alloc = await createAllocation({
    expenseTypeId: held.recurring.expenseTypeId,
    allocationMethod: 'SPLIT_EVEN',
    truckIds: [to.id],
    notes: `Auto — unit ${to.unitNumber} (${held.slot === 'plates' ? 'plates' : 'ELD'} from unit ${held.truck.unitNumber})`,
  })
  await createRecurringExpense({
    expenseTypeId: held.recurring.expenseTypeId,
    allocationId: alloc.id,
    monthlyAmount: held.recurring.monthlyAmount,
    startMonth: monthOf(from),
    startDate: from,
    endMonth: null,
    endDate: null,
    active: true,
    notes: `Auto — truck ${to.unitNumber}, moved from parked unit ${held.truck.unitNumber}`,
  })
  await stopCharging(held.recurring, from)
}
