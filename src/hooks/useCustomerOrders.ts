import { useCallback, useEffect, useMemo, useState } from 'react'
import { listCustomers, listLoads } from '@/lib/apiClient'
import { customerMatchesLoad, customerNameKeys } from '@/lib/customerCredit'
import type { Load } from '@/types'
import type { CustomerRecord } from '@/types/tms'

/**
 * Load the matched order history for a customer. Uses the same attribution rule as
 * credit exposure: `customerId` link first, then normalized name/alias fallback.
 *
 * The optional `customer` record is accepted so callers that already have it (e.g.
 * the profile drawer) can avoid an extra customer scan.
 */
export function useCustomerOrders(customerId: string, customer?: CustomerRecord) {
  const [allLoads, setAllLoads] = useState<Load[]>([])
  const [customerRecord, setCustomerRecord] = useState<CustomerRecord | null>(customer ?? null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() =>
    Promise.all([
      listLoads(),
      customer
        ? Promise.resolve<CustomerRecord | null>(customer)
        : listCustomers({ includeArchived: true }).then((rows) => rows.find((c) => c.id === customerId) ?? null),
    ])
      .then(([loads, customerFromServer]) => {
        if (!customerFromServer) {
          setAllLoads([])
          setCustomerRecord(null)
          setError('Customer not found')
        } else {
          setAllLoads(loads)
          setCustomerRecord(customerFromServer)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load customer orders')
      })
      .finally(() => {
        setLoading(false)
      }),
  [customer, customerId])
  const refetch = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => {
    void load()
  }, [load])

  const loads = useMemo(() => {
    if (!customerRecord) return [] as Load[]
    const names = customerNameKeys(customerRecord)
    const matched = allLoads.filter((l) => customerMatchesLoad(customerRecord, l, names))
    matched.sort((a, b) => b.pickupAppt.localeCompare(a.pickupAppt))
    return matched
  }, [allLoads, customerRecord])

  const lastLoadAt = useMemo(() => {
    if (loads.length === 0) return null
    return loads.reduce((latest, l) => (l.pickupAppt > latest ? l.pickupAppt : latest), loads[0].pickupAppt)
  }, [loads])

  return { loads, lastLoadAt, loading, error, refetch }
}
