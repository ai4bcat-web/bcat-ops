/**
 * Everything one carrier bill page renders: the bill itself, the shipment it came off,
 * the remittances that carried it and the money that has gone against it.
 *
 * The shipment bundle is read because a bill is a snapshot — it knows its own lines and
 * nothing about the stops, the loads or the carrier paperwork the approval gate turns on,
 * all of which the detail page shows. Notices are the shipment's, narrowed to
 * `REMITTANCE`: that is where a NOT_SENT e-mail and its copyable body live, which on dev
 * (SES denied) is every one of them. Payments are the carrier's rows narrowed to the ones
 * that touch this bill — in an application, or as a credit raised against this very
 * assignment, which is money this leg owes back even before it is applied.
 *
 * Polled on the 60 s TMS clock; none of these models has subscriptions.
 */
import { useCallback, useEffect, useState } from 'react'
import { getCarrierBill, getShipmentBundle, listApPaymentsByCarrier, listShipmentNotices } from '@/lib/apiClient'
import type { ApPaymentRecord, CarrierBillRecord, ShipmentBundle, ShipmentNoticeRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface CarrierBillDetailData {
  bill: CarrierBillRecord | null
  /** The shipment this was billed off, with its orders, loads, charges and documents. */
  bundle: ShipmentBundle | null
  /** This shipment's REMITTANCE notices, newest first — the send history. */
  notices: ShipmentNoticeRecord[]
  /** AP rows that touch this bill, newest first. */
  payments: ApPaymentRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useCarrierBill(id: string | null): CarrierBillDetailData {
  const enabled = !!id
  const [bill, setBill] = useState<CarrierBillRecord | null>(null)
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [notices, setNotices] = useState<ShipmentNoticeRecord[]>([])
  const [payments, setPayments] = useState<ApPaymentRecord[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain. The
  // shipment and the cash can only be read once the bill has named them, so this is two
  // round trips deep rather than one — the second fans out in parallel.
  const load = useCallback(() => {
    if (!id) return Promise.resolve()
    return getCarrierBill(id)
      .then((row) => {
        setBill(row)
        if (!row) {
          setBundle(null)
          setNotices([])
          setPayments([])
          setError('Carrier bill not found')
          return
        }
        return Promise.all([
          getShipmentBundle(row.shipmentId),
          listShipmentNotices(row.shipmentId),
          listApPaymentsByCarrier(row.carrierId),
        ]).then(([shipmentBundle, noticeRows, paymentRows]) => {
          setBundle(shipmentBundle)
          setNotices(noticeRows.filter((n) => n.kind === 'REMITTANCE'))
          setPayments(paymentRows.filter((p) => (
            p.loadCarrierId === row.loadCarrierId || (p.applications ?? []).some((a) => a.billId === row.id)
          )))
          setError(null)
        })
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Carrier bill failed to load') })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled, load])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { bill, bundle, notices, payments, loading, error, refresh }
}
