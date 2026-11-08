/**
 * Everything one invoice page renders: the bill itself, the shipment it came off, the
 * e-mails that carried it and the cash that has been put against it.
 *
 * The shipment bundle is read because an invoice is a snapshot — it knows its own lines
 * and nothing about the stops, the loads or the documents that are attached to it, all
 * of which the detail page shows. Notices are the shipment's, narrowed to `INVOICE`:
 * that is where a NOT_SENT e-mail and its copyable body live, which on dev (SES denied)
 * is every one of them. Payments are the customer's rows narrowed to the ones that name
 * this invoice — either in an application or, for a write-off, on the row itself.
 *
 * Polled on the 60 s TMS clock; none of these models has subscriptions.
 */
import { useCallback, useEffect, useState } from 'react'
import { getInvoice, getShipmentBundle, listArPaymentsByCustomer, listShipmentNotices } from '@/lib/apiClient'
import type { ArPaymentRecord, InvoiceRecord, ShipmentBundle, ShipmentNoticeRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface InvoiceDetailData {
  invoice: InvoiceRecord | null
  /** The shipment this was billed off, with its orders, loads, charges and documents. */
  bundle: ShipmentBundle | null
  /** This shipment's INVOICE notices, newest first — the send history. */
  notices: ShipmentNoticeRecord[]
  /** Cash rows that name this invoice, newest first. */
  payments: ArPaymentRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useInvoice(id: string | null): InvoiceDetailData {
  const enabled = !!id
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null)
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [notices, setNotices] = useState<ShipmentNoticeRecord[]>([])
  const [payments, setPayments] = useState<ArPaymentRecord[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain. The
  // shipment and the cash can only be read once the invoice has named them, so this is
  // two round trips deep rather than one — the second fans out in parallel.
  const load = useCallback(() => {
    if (!id) return Promise.resolve()
    return getInvoice(id)
      .then((row) => {
        setInvoice(row)
        if (!row) {
          setBundle(null)
          setNotices([])
          setPayments([])
          setError('Invoice not found')
          return
        }
        return Promise.all([
          getShipmentBundle(row.shipmentId),
          listShipmentNotices(row.shipmentId),
          listArPaymentsByCustomer(row.customerId),
        ]).then(([shipmentBundle, noticeRows, paymentRows]) => {
          setBundle(shipmentBundle)
          setNotices(noticeRows.filter((n) => n.kind === 'INVOICE'))
          setPayments(paymentRows.filter((p) => (
            p.invoiceId === row.id || (p.applications ?? []).some((a) => a.invoiceId === row.id)
          )))
          setError(null)
        })
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Invoice failed to load') })
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

  return { invoice, bundle, notices, payments, loading, error, refresh }
}
