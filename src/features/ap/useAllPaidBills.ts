import { useEffect, useState } from 'react'
import { listBillsByMonth } from '@/lib/apiClient'
import { lastMonths } from '@/features/ar/arViews'
import type { CarrierBillRecord } from '@/types/tms'

/** The oldest bill month AP holds (the Aljex carry-over reaches back to here). */
export const AP_FIRST_BILL_MONTH = '2024-01'

/** Every bill month from the first AP month through `asOf`'s month, newest first. */
export function billMonthsSince(asOf: string, first: string = AP_FIRST_BILL_MONTH): string[] {
  const [fy, fm] = first.split('-').map(Number)
  const [ay, am] = asOf.slice(0, 7).split('-').map(Number)
  const count = (ay - fy) * 12 + (am - fm) + 1
  return count > 0 ? lastMonths(asOf, count) : []
}

/**
 * Every bill ever recorded, read month by month through the billMonth index (there is no index on paid
 * date), so the Paid tab can list payments by the month they were paid in and show all of them at once.
 * Reads only while `enabled` (the Paid tab is open) and again when `refreshKey` moves, e.g. after a payment posts.
 */
export function useAllPaidBills(asOf: string, enabled: boolean, refreshKey: number): { bills: CarrierBillRecord[]; loading: boolean } {
  const [read, setRead] = useState<{ key: number | null; bills: CarrierBillRecord[] }>({ key: null, bills: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || read.key === refreshKey) return
    let alive = true
    // Every state write sits in the promise chain (react-hooks/set-state-in-effect).
    Promise.resolve()
      .then(() => { if (alive) setLoading(true) })
      .then(() => Promise.all(billMonthsSince(asOf).map((month) => listBillsByMonth(month))))
      .then((groups) => { if (alive) setRead({ key: refreshKey, bills: groups.flat() }) })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [asOf, enabled, refreshKey, read.key])

  return { bills: read.bills, loading }
}
