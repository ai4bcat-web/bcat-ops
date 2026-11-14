/** Method and check/ref # behind each paid carrier bill, for the AP Paid card. Read while the tab is open, kept five minutes. */
import { useEffect, useState } from 'react'
import { listApPayments } from '@/lib/apiClient'
import { cachedList } from '@/lib/listCache'
import type { ApPaymentRecord } from '@/types/tms'
import { billPaymentLines, type BillPaymentLine } from './accountingStats'

const EMPTY: ReadonlyMap<string, BillPaymentLine> = new Map()

export function useApPaymentLines(enabled: boolean, refreshKey = 0): ReadonlyMap<string, BillPaymentLine> {
  const [lines, setLines] = useState<ReadonlyMap<string, BillPaymentLine>>(EMPTY)
  useEffect(() => {
    if (!enabled) return
    let live = true
    Promise.resolve()
      .then(() => cachedList<ApPaymentRecord[]>(`ap:payments:${refreshKey}`, () => listApPayments(), { ttlMs: 300_000 }))
      .then((rows) => { if (live) setLines(billPaymentLines(rows)) })
      .catch(() => { /* the split shows everything as not recorded */ })
    return () => { live = false }
  }, [enabled, refreshKey])
  return lines
}
