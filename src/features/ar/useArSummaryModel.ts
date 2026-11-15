/**
 * The Receivables data the Invoicing page and the Operations Dashboard both read.
 *
 * One hook, one set of reads, one summary function: the dashboard's Accounting cards and the
 * Invoicing page's cards are computed by the same code from the same rows, so the two can
 * never show different numbers for the same money (Ryne 2026-11-15).
 *
 * `month` is the Paid tab's picked month on the page; the factoring queue rows look PROs up
 * in its invoices, so the dashboard passes the current month (the page's default).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useArWorklist } from '@/hooks/useArWorklist'
import { useOpenInvoices } from '@/hooks/useOpenInvoices'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { graphqlErrorText, listInvoicesByMonth, listUserProfiles } from '@/lib/apiClient'
import { loadWorklistShipments } from '@/lib/worklistShipments'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord, ShipmentRecord, UserProfileRecord } from '@/types/tms'
import { computeArSummary, type ArSummary } from './arSummary'
import { lastMonths, PAID_LOOKBACK_MONTHS } from './arViews'
import {
  billedByMatches, buildReadyRows, factorQueueRows, isInvoiceSent, splitOpenInvoices,
  type ArBilledBy, type ArQueueLookups, type ArQueueRow,
} from './arQueue'

export function useArSummaryModel(asOf: string, month: string) {
  // Released to billing from Load Review = Order.arStatus UNBILLED.
  const unbilled = useArWorklist('UNBILLED')
  // Invoiced-but-unpaid orders: the shipments behind the open invoices, and their release dates.
  const invoiced = useArWorklist('UNPAID')
  const open = useOpenInvoices()
  const { items: factoringItems, refresh: refreshFactoring } = useFactoringItems()
  const { divisions } = useOwnershipDivisions()

  const [profiles, setProfiles] = useState<UserProfileRecord[]>([])
  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => listUserProfiles())
      .then((rows) => { if (alive) setProfiles(rows ?? []) })
      .catch(() => { /* names fall back to the id */ })
    return () => { alive = false }
  }, [])

  // Invoices issued in the picked month: the factoring queue and Needs review look PROs up in them. The Paid
  // tab itself reads `paidInMonth` (by paid date). No synchronous setState in the effect: writes live in the chain.
  const [paidInvoices, setPaidInvoices] = useState<InvoiceRecord[]>([])
  const loadMonth = useCallback(() =>
    listInvoicesByMonth(month)
      .then((rows) => setPaidInvoices(rows))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load that month')),
  [month])
  useEffect(() => { loadMonth() }, [loadMonth])

  // Invoices issued over the last six months: the days-to-pay figures (90-day window), "Collected this
  // week / month" and the Paid tab all read this one set, by paid date, so the card and the tab agree.
  const [recentPaid, setRecentPaid] = useState<InvoiceRecord[]>([])
  const [recentLoaded, setRecentLoaded] = useState(false)
  const recentMonths = useMemo(() => lastMonths(asOf, PAID_LOOKBACK_MONTHS), [asOf])
  const loadRecent = useCallback(() =>
    Promise.all(recentMonths.map((m) => listInvoicesByMonth(m).catch(() => [] as InvoiceRecord[])))
      .then((sets) => setRecentPaid(sets.flat()))
      .finally(() => setRecentLoaded(true)),
  [recentMonths])
  useEffect(() => { void loadRecent() }, [loadRecent])

  // Shipments behind paid invoices are not in any worklist; read them by id for division and rep.
  const [paidShipments, setPaidShipments] = useState<ShipmentRecord[]>([])
  const paidShipmentIds = useMemo(
    () => [...new Set([...paidInvoices, ...recentPaid].filter((inv) => inv.status === 'PAID').map((inv) => inv.shipmentId))].sort().join(','),
    [paidInvoices, recentPaid],
  )
  useEffect(() => {
    let alive = true
    const ids = paidShipmentIds.split(',').filter(Boolean)
    Promise.resolve()
      .then(() => (ids.length ? loadWorklistShipments(ids) : []))
      .then((rows) => { if (alive) setPaidShipments(rows ?? []) })
      .catch(() => { /* division and rep fall back to the invoice */ })
    return () => { alive = false }
  }, [paidShipmentIds])

  const factorByItemId = useMemo(() => {
    const map = new Map<string, FactoringItem>()
    for (const item of factoringItems) map.set(item.id, item)
    return map
  }, [factoringItems])

  const lookups: ArQueueLookups = useMemo(() => {
    const shipmentsById = new Map<string, ShipmentRecord>()
    for (const s of paidShipments) shipmentsById.set(s.id, s)
    for (const r of [...unbilled.rows, ...invoiced.rows]) if (r.shipment) shipmentsById.set(r.shipmentId, r.shipment)
    const divisionByCode = new Map((divisions ?? []).map((d) => [d.code, d.name]))
    const profileById = new Map<string, UserProfileRecord>()
    for (const p of profiles) {
      if (p.id) profileById.set(p.id, p)
      if (p.email) profileById.set(p.email, p)
    }
    return {
      shipmentsById,
      asOf,
      divisionName: (code) => (code ? divisionByCode.get(code) ?? code : 'No division'),
      repName: (id) => {
        if (!id) return 'No sales rep'
        const p = profileById.get(id)
        return p?.name ?? p?.email ?? id
      },
    }
  }, [paidShipments, unbilled.rows, invoiced.rows, divisions, profiles, asOf])

  const releasedByOrder = useMemo(
    () => new Map(invoiced.rows.map((r) => [r.orderId, r.order.readyToInvoiceAt ?? null])),
    [invoiced.rows],
  )

  // Auto-generated on release but not yet sent = a draft for review in Ready to invoice. Drafts are not
  // receivables yet: the cards, the Invoiced tab and Aging all count the same sent set (`sentOpen`).
  const split = useMemo(() => splitOpenInvoices(open.invoices, lookups, releasedByOrder, (inv) =>
    isInvoiceSent(inv, inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : null)),
  [open.invoices, lookups, releasedByOrder, factorByItemId])
  const sentOpen = useMemo(() => {
    const drafts = new Set(split.drafts.map((r) => r.invoiceId))
    return open.invoices.filter((inv) => !drafts.has(inv.id))
  }, [open.invoices, split.drafts])

  const summarize = useCallback((openInvoices: InvoiceRecord[], paid: InvoiceRecord[]) => computeArSummary({
    open: openInvoices,
    paid,
    factorByItemId,
    shipmentsById: lookups.shipmentsById,
    divisionName: lookups.divisionName,
    asOf,
  }), [factorByItemId, lookups, asOf])
  // Every sent invoice, every billing, no customer or division narrowing.
  const summaryAll = useMemo(() => summarize(sentOpen, recentPaid), [summarize, sentOpen, recentPaid])
  // The Receivables card as it reads with nothing filtered (the dashboard's view).
  const cardSummary = useMemo(
    () => receivablesSummary(summarize, { owned: sentOpen, party: sentOpen, paid: recentPaid }),
    [summarize, sentOpen, recentPaid],
  )

  return {
    unbilled, invoiced, open, factoringItems, refreshFactoring, divisions,
    paidInvoices, loadMonth, recentPaid, recentLoaded, loadRecent,
    factorByItemId, lookups, split, sentOpen, summarize, summaryAll, cardSummary,
  }
}

export type ArSummaryModel = ReturnType<typeof useArSummaryModel>

/**
 * The Receivables card: totals over the invoices the filters keep (`owned`, and the `paid` ones for
 * the collected and days-to-pay rows), and each division's share of the selected customers' invoices
 * (`party`) so there is always a division to pick.
 */
export function receivablesSummary(
  summarize: (open: InvoiceRecord[], paid: InvoiceRecord[]) => ArSummary,
  { owned, party, paid }: { owned: InvoiceRecord[]; party: InvoiceRecord[]; paid: InvoiceRecord[] },
): ArSummary {
  return { ...summarize(owned, paid), byDivision: summarize(party, []).byDivision }
}

/** What Ready to invoice is built from: the released orders, the open drafts and the factoring queue. */
export interface ReadyQueueInputs {
  unbilledRows: ArSummaryModel['unbilled']['rows']
  drafts: ArQueueRow[]
  monthInvoices: InvoiceRecord[]
  openInvoices: InvoiceRecord[]
  factoringItems: FactoringItem[]
  lookups: ArQueueLookups
}

/**
 * The Ready to invoice rows: drafts not already listed, the released orders, and the factoring
 * queue rows not yet at OTR. `keep` is the page's filter (billed-by, customer, division, due);
 * the queue rows are always listed, whatever the billed-by view.
 */
export function readyQueueRows(m: ReadyQueueInputs, keep: (rows: ArQueueRow[]) => ArQueueRow[]): ArQueueRow[] {
  const ready = buildReadyRows(m.unbilledRows, m.lookups)
  const readyOrders = new Set(ready.map((r) => r.orderId))
  const rows = keep([...m.drafts.filter((r) => !readyOrders.has(r.orderId)), ...ready])
  // Paid invoices too: a queue row for a PRO that is already billed and paid is not new work either.
  const invoicesById = new Map([...m.monthInvoices, ...m.openInvoices].map((inv) => [inv.id, inv]))
  return [...rows, ...factorQueueRows(m.factoringItems, rows, invoicesById, m.lookups)]
}

/** Ready to invoice with nothing filtered (the dashboard's view): every billing unless told otherwise. */
export function readyQueueUnfiltered(m: ReadyQueueInputs, billedBy: ArBilledBy = 'all'): ArQueueRow[] {
  return readyQueueRows(m, (rows) => rows.filter((row) => billedByMatches(row, billedBy)))
}
