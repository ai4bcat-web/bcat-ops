/**
 * The Payables data the Invoicing page's Payable view and the Operations Dashboard both read.
 *
 * One hook, one set of reads, one summary function, so the dashboard's Accounting cards and the
 * Payables cards cannot disagree about the same bills (Ryne 2026-11-15).
 */
import { useEffect, useMemo, useState } from 'react'
import { useOpenBills } from '@/hooks/useOpenBills'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { listBillsByMonth } from '@/lib/apiClient'
import { lastThreeMonths } from '@/features/ar/arViews'
import type { CarrierBillRecord } from '@/types/tms'
import { apSummary, payablesQueue, type BillFactsIndex } from './apQueue'
import { billsAging, billsExpected, billsSelected } from './apViews'
import { useBillFacts } from './useBillFacts'

export function useApSummaryModel(asOf: string) {
  const open = useOpenBills()
  const months = useMemo(() => lastThreeMonths(asOf), [asOf])

  // Bills paid in the last three months: the strip's days-to-pay and this month's quick pay.
  const [paidRecent, setPaidRecent] = useState<CarrierBillRecord[]>([])
  useEffect(() => {
    let alive = true
    Promise.all(months.map((m) => listBillsByMonth(m)))
      .then((sets) => { if (alive) setPaidRecent(sets.flat().filter((b) => b.status === 'PAID')) })
      .catch(() => {})
    return () => { alive = false }
  }, [months])
  const factBills = useMemo(() => [...open.bills, ...paidRecent], [open.bills, paidRecent])
  const { facts } = useBillFacts(factBills)
  const { divisions } = useOwnershipDivisions()
  const divisionName = useMemo(() => {
    const byCode = new Map((divisions ?? []).map((d) => [d.code, d.name]))
    return (code: string | null) => (code ? byCode.get(code) ?? code : 'No division')
  }, [divisions])

  // The totals always count every open bill, Aljex ones included: that money is still owed. Only
  // the lists sit behind the Aljex toggle.
  const totalsAll = useMemo(() => payablesQueue(open.bills, facts, { includeAljex: true }), [open.bills, facts])
  // Nothing filtered: the Payables card as it reads with no carrier or division picked.
  const summaryAll = useMemo(
    () => payablesSummary({ owned: totalsAll, party: totalsAll, paidRecent, facts, asOf }),
    [totalsAll, paidRecent, facts, asOf],
  )

  return { open, months, paidRecent, facts, divisionName, totalsAll, summaryAll }
}

/**
 * The Payables card: totals over the bills the filters keep (`owned`), and each division's share of
 * the selected carriers' bills (`party`) so there is always a division to pick.
 */
export function payablesSummary({ owned, party, paidRecent, facts, asOf }: {
  owned: CarrierBillRecord[]
  party: CarrierBillRecord[]
  /** Already narrowed to the same carriers and divisions as `owned`. */
  paidRecent: CarrierBillRecord[]
  facts: BillFactsIndex
  asOf: string
}) {
  const narrowed = apSummary({
    expected: billsExpected(owned),
    aging: billsAging(owned),
    selected: billsSelected(owned),
    paidRecent,
    facts,
    asOf,
  })
  const shares = apSummary({
    expected: billsExpected(party),
    aging: billsAging(party),
    selected: billsSelected(party),
    paidRecent: [],
    facts,
    asOf,
  })
  return { ...narrowed, byDivision: shares.byDivision }
}
