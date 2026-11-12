/**
 * The attachment plan (invoice PDF, POD, rate con) for a set of invoices, fetched in
 * chunks and cached by invoice id. Feeds the Ready to invoice / Invoiced columns and the
 * send review. `refresh` drops the cache, e.g. after a POD is filed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getInvoiceAttachmentPlans } from '@/lib/apiClient'
import type { InvoiceAttachmentPlanRow } from '@/lib/invoiceDelivery'

const CHUNK = 100

export function useInvoiceAttachmentPlans(invoiceIds: readonly string[]): {
  plans: Map<string, InvoiceAttachmentPlanRow>
  loading: boolean
  refresh: () => void
} {
  const [plans, setPlans] = useState<Map<string, InvoiceAttachmentPlanRow>>(() => new Map())
  const [epoch, setEpoch] = useState(0)
  const key = useMemo(() => [...new Set(invoiceIds)].sort().join('|'), [invoiceIds])

  useEffect(() => {
    const wanted = key ? key.split('|') : []
    const missing = wanted.filter((id) => !plans.has(id))
    if (missing.length === 0) return
    let alive = true
    const chunks: string[][] = []
    for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK))
    Promise.all(chunks.map((ids) => getInvoiceAttachmentPlans(ids).catch(() => ids.map((invoiceId) => ({ invoiceId, error: 'Could not check attachments' })))))
      .then((rows) => {
        if (!alive) return
        setPlans((prev) => {
          const next = new Map(prev)
          for (const row of rows.flat()) next.set(row.invoiceId, row)
          return next
        })
      })
    return () => { alive = false }
    // `plans` is read for what is already cached; refetching on every plan change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, epoch])

  const refresh = useCallback(() => { setPlans(new Map()); setEpoch((n) => n + 1) }, [])
  const loading = key !== '' && key.split('|').some((id) => !plans.has(id))
  return { plans, loading, refresh }
}

/** ✓ / — / ⚠ wording for one cell, shared by the list and the review. */
export function attachmentStateText(state: 'ATTACHED' | 'NOT_INCLUDED' | 'MISSING' | undefined): string {
  if (state === 'ATTACHED') return '✓ Attached'
  if (state === 'NOT_INCLUDED') return '— Not included'
  if (state === 'MISSING') return '⚠ Missing'
  return '…'
}
