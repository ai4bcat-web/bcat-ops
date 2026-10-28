import { useCallback, useEffect, useMemo, useState } from 'react'
import { listCustomers, listLoads, listOrdersByCustomer, listShipmentsByCustomer } from '@/lib/apiClient'
import { customerMatchesLoad, customerNameKeys } from '@/lib/customerCredit'
import type { Load } from '@/types'
import type { CustomerRecord, OrderRecord, ShipmentRecord } from '@/types/tms'

/**
 * A customer's order history, from both eras.
 *
 * `orders` is the shipment layer's record — everything booked since step B, read
 * straight off the customer index. `loads` is every load attributed to this customer
 * by the same rule credit exposure uses: `customerId` link first, then normalized
 * name/alias fallback. `legacyLoads` narrows that to the ones no order covers, which
 * is the fallback section the profile shows beneath the orders.
 *
 * The optional `customer` record is accepted so callers that already have it (e.g.
 * the profile drawer) can avoid an extra customer scan.
 */
export function useCustomerOrders(customerId: string, customer?: CustomerRecord) {
  const [allLoads, setAllLoads] = useState<Load[]>([])
  const [orders, setOrders] = useState<OrderRecord[]>([])
  // The orders' shipments, so a caller can price credit exposure (which needs the
  // shipment's status and delivery) without a second round trip per order.
  const [shipments, setShipments] = useState<ShipmentRecord[]>([])
  const [customerRecord, setCustomerRecord] = useState<CustomerRecord | null>(customer ?? null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() =>
    Promise.all([
      listLoads(),
      listOrdersByCustomer(customerId),
      listShipmentsByCustomer(customerId),
      customer
        ? Promise.resolve<CustomerRecord | null>(customer)
        : listCustomers({ includeArchived: true }).then((rows) => rows.find((c) => c.id === customerId) ?? null),
    ])
      .then(([loads, customerOrders, customerShipments, customerFromServer]) => {
        if (!customerFromServer) {
          setAllLoads([])
          setOrders([])
          setShipments([])
          setCustomerRecord(null)
          setError('Customer not found')
        } else {
          setAllLoads(loads)
          setOrders(customerOrders)
          setShipments(customerShipments)
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

  // Loads an order already accounts for would show the same job twice.
  const legacyLoads = useMemo(() => loads.filter((l) => !l.orderId), [loads])

  return { orders, shipments, loads, legacyLoads, lastLoadAt, loading, error, refetch }
}
