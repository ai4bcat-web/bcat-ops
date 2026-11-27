/**
 * Reads what the Auto shipper loads page needs, and only what the viewer may see: the AR invoices only with the AR grant,
 * the carrier assignments, bills and payees only with the AP grant. The shipments, their orders and the car-shipping details
 * (payer, vehicle) are the same for everyone who opens the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  graphqlErrorText, listBillsByCarrier, listCarShippingByShipmentIds, listCarrierPaymentInfo, listCustomers, listInvoicesByCustomer,
  listLoadCarriersByShipmentIds, listOrdersByShipmentIds, listShipmentsByCustomer, type CarrierPaymentInfo,
} from '@/lib/apiClient'
import { payeeNameFor } from '@/features/ap/apViews'
import { buildAutoShipperRows, isAutoShipperCustomer, type AutoShipperRow } from './autoShipperLoads'
import type { CarrierBillRecord, InvoiceRecord, LoadCarrierRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import type { CarShippingData } from '@/lib/squareInvoicing'

interface Raw {
  shipments: ShipmentRecord[]
  orders: OrderRecord[]
  invoices: InvoiceRecord[]
  legs: LoadCarrierRecord[]
  bills: CarrierBillRecord[]
  carShipping: Map<string, CarShippingData | null>
  infos: CarrierPaymentInfo[]
}

const EMPTY: Raw = { shipments: [], orders: [], invoices: [], legs: [], bills: [], carShipping: new Map(), infos: [] }

export function useAutoShipperLoads(opts: { asOf: string; showAr: boolean; showAp: boolean }): {
  rows: AutoShipperRow[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const { asOf, showAr, showAp } = opts
  const [raw, setRaw] = useState<Raw>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose (react-hooks/set-state-in-effect): every state write lives in the promise chain.
  const refresh = useCallback((): Promise<void> => (
    listCustomers({ includeArchived: true })
      .then(async (customers) => {
        const ids = customers.filter(isAutoShipperCustomer).map((c) => c.id)
        const shipments = (await Promise.all(ids.map((id) => listShipmentsByCustomer(id)))).flat()
        const shipmentIds = [...new Set(shipments.map((s) => s.id))]
        const wanted = new Set(shipmentIds)
        const [orders, carShipping, invoices, legs, infos] = await Promise.all([
          listOrdersByShipmentIds(shipmentIds),
          listCarShippingByShipmentIds(shipmentIds),
          showAr ? Promise.all(ids.map((id) => listInvoicesByCustomer(id))).then((sets) => sets.flat().filter((i) => wanted.has(i.shipmentId))) : Promise.resolve([] as InvoiceRecord[]),
          showAp ? listLoadCarriersByShipmentIds(shipmentIds) : Promise.resolve([] as LoadCarrierRecord[]),
          showAp ? listCarrierPaymentInfo().catch(() => [] as CarrierPaymentInfo[]) : Promise.resolve([] as CarrierPaymentInfo[]),
        ])
        // The recorded bills are read per carrier (the Payables page's own read) and kept for these loads only.
        const carrierIds = [...new Set(legs.map((l) => l.carrierId).filter((id): id is string => Boolean(id)))]
        const bills = showAp
          ? (await Promise.all(carrierIds.map((id) => listBillsByCarrier(id, { includeArchived: true })))).flat().filter((b) => wanted.has(b.shipmentId))
          : []
        setRaw({ shipments, orders, invoices, legs, bills, carShipping, infos })
        setError(null)
      })
      .catch((e: unknown) => setError(graphqlErrorText(e) || 'Auto shipper loads could not load'))
      .finally(() => setLoading(false))
  ), [showAr, showAp])

  useEffect(() => { void refresh() }, [refresh])

  const rows = useMemo(() => buildAutoShipperRows({
    ...raw,
    payTo: (bill) => payeeNameFor(bill, raw.infos),
    asOf,
    showAr,
    showAp,
  }), [raw, asOf, showAr, showAp])

  return { rows, loading, error, refresh }
}
