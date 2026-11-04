/** The customer directory as an id → record map (one cached read), for the company chip and the picker. */
import { useEffect, useState } from 'react'
import { listCustomers } from '@/lib/apiClient'
import type { CustomerRecord } from '@/types/tms'

/** The lead stages: a customer in one of these is a prospect until its first shipment. */
export const PROSPECT_STATUSES: Record<string, true> = { NEW: true, CONTACTED: true, QUALIFIED: true, QUOTED: true, NURTURING: true }

export function useCustomerList(): { customers: CustomerRecord[]; reload: () => void } {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    listCustomers()
      .then((rows) => { if (live) setCustomers(rows) })
      .catch(() => { if (live) setCustomers([]) })
    return () => { live = false }
  }, [tick])
  return { customers, reload: () => setTick((n) => n + 1) }
}
