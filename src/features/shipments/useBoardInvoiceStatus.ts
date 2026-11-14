/**
 * The live reads behind the board's invoice pill: the open invoices (one sparse-index query) and the OTR
 * queue. Only a load past Load Review has an invoice to speak of, and those loads list only on All (or a
 * search), so nothing is read until one of those is showing. A failed read leaves the order's cached AR
 * fields to decide (`invoiceStatusOfRow`), so the pill degrades to Outstanding rather than disappearing.
 * Polled on the 60 s TMS clock while the tab is visible, like the AR page's open book.
 */
import { useEffect, useMemo, useState } from 'react'
import { listFactoringItems, listOpenInvoices } from '@/lib/apiClient'
import { isReleasedToInvoicing } from '@/lib/shipmentLists'
import { loadInvoiceStatusOf } from '@/lib/loadInvoiceStatus'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord } from '@/types/tms'
import type { ShipmentRow } from './shipmentViews'

const POLL_MS = 60_000

export function useBoardInvoiceSources(enabled: boolean): { invoices: InvoiceRecord[]; items: FactoringItem[] } {
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([])
  const [items, setItems] = useState<FactoringItem[]>([])

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    const load = () => {
      listOpenInvoices().then((rows) => { if (alive) setInvoices(rows) }).catch(() => { /* cached AR fields decide */ })
      listFactoringItems().then((rows) => { if (alive) setItems(rows) }).catch(() => { /* no factoring access: cached AR fields decide */ })
    }
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled])

  return { invoices, items }
}

/** Stamps each released row with its invoice status from the live reads; earlier rows are returned as they are. */
export function withInvoiceStatus(rows: ShipmentRow[], invoices: readonly InvoiceRecord[], items: readonly FactoringItem[]): ShipmentRow[] {
  if (invoices.length === 0 && items.length === 0) return rows
  const invoiceById = new Map(invoices.map((inv) => [inv.id, inv]))
  const itemById = new Map(items.map((item) => [item.id, item]))
  return rows.map((row) => {
    if (!isReleasedToInvoicing(row)) return row
    const invoice = row.invoiceId ? invoiceById.get(row.invoiceId) ?? null : null
    const itemId = row.factoringItemId ?? invoice?.factoringItemId ?? null
    const item = itemId ? itemById.get(itemId) ?? null : null
    return { ...row, invoiceStatus: loadInvoiceStatusOf(row, invoice, item) }
  })
}

export function useRowsWithInvoiceStatus(rows: ShipmentRow[], enabled: boolean): ShipmentRow[] {
  const { invoices, items } = useBoardInvoiceSources(enabled)
  return useMemo(() => withInvoiceStatus(rows, invoices, items), [rows, invoices, items])
}
