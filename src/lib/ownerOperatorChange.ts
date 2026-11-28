import type { DriverFleet } from '@/types/equipment'
import { classificationForFleet } from './fileHub'
import { createAuditLog, createDriverPaySetting, listDriverPaySettings, updateDriverPaySetting } from './apiClient'
import { withOwnerOpFrom, withOwnerOpTo, type PayRateOverride } from './driverPay'

/** The driver is an owner operator by the fleet they run in (Amazon drivers are owner operators too). */
export function isOwnerOperatorFleet(fleetGroup: DriverFleet | null | undefined): boolean {
  return classificationForFleet(fleetGroup) === 'OWNER_OPERATOR'
}

/** START: an existing driver is being switched to owner operator. END: switched away. null: no change. */
export type OwnerOperatorChange = 'START' | 'END'
export function ownerOperatorChange(before: DriverFleet | null | undefined, after: DriverFleet | null | undefined): OwnerOperatorChange | null {
  const was = isOwnerOperatorFleet(before)
  const now = isOwnerOperatorFleet(after)
  return was === now ? null : now ? 'START' : 'END'
}

/** The rate the marker windows carry along. They never pay anything: a 'NONE' window only says "not on the owner-operator payroll". */
const MARKER_RATE = { payPercent: 0, expensesBeforePercent: false }

/** Drop a trailing "left on" marker, for a driver switched back to owner operator. */
function withoutLeaving(history: PayRateOverride[] | null | undefined): PayRateOverride[] {
  return (history ?? []).filter((w) => !(w.payGroup === 'NONE' && w.ownerOpTo))
}

/**
 * Record the day an existing driver became (START) or stopped being (END) an owner operator, in the pay setting's dated windows
 * (`rateHistory`, the same history that pins pay rates and modes by week), and write an audit row with who, from/to and the date.
 * Weeks before a START day are marked "not owner operator" so they stay on whatever the driver was before, and nothing already settled
 * is rewritten. A driver with no pay setting gets one at 0% so the page can list them until their pay terms are set.
 */
export async function recordOwnerOperatorChange(i: {
  driverId: string
  driverName: string
  change: OwnerOperatorChange
  day: string
  who: string
  fromFleet: DriverFleet | null | undefined
  toFleet: DriverFleet | null | undefined
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.day)) throw new Error('Enter the date as YYYY-MM-DD.')
  const existing = (await listDriverPaySettings()).find((s) => s.driverId === i.driverId)
  if (i.change === 'START') {
    if (existing) {
      const base = { payPercent: existing.payPercent, expensesBeforePercent: existing.expensesBeforePercent }
      await updateDriverPaySetting(existing.id, { rateHistory: withOwnerOpFrom(withoutLeaving(existing.rateHistory), i.day, base) }, existing.updatedAt)
    } else {
      await createDriverPaySetting({
        driverId: i.driverId, payGroup: 'OWNER_OPERATOR', ...MARKER_RATE, active: true, fixedExpenses: [],
        rateHistory: withOwnerOpFrom(null, i.day, MARKER_RATE),
      })
    }
  } else {
    // Nothing to end without a setting: such a driver was never listed.
    if (existing) {
      const base = { payPercent: existing.payPercent, expensesBeforePercent: existing.expensesBeforePercent }
      await updateDriverPaySetting(existing.id, { rateHistory: withOwnerOpTo(existing.rateHistory, i.day, base) }, existing.updatedAt)
    }
  }
  await createAuditLog({
    entityType: 'Driver', entityId: i.driverId, action: 'update', user: i.who,
    changes: {
      ownerOperator: { from: isOwnerOperatorFleet(i.fromFleet) ? 'Owner operator' : 'Company driver', to: isOwnerOperatorFleet(i.toFleet) ? 'Owner operator' : 'Company driver' },
      [i.change === 'START' ? 'ownerOperatorFrom' : 'ownerOperatorUntil']: { from: null, to: i.day },
    },
  })
}
