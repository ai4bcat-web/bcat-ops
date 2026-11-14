/**
 * "Ready to factor" for the rows of Ready to invoice: ✓, or what is missing.
 *
 * Order rows ask the server (PREVIEW_FACTOR_READY, read-only, 50 a call). Rows that are
 * already factoring-queue rows ask the queue's own readiness (otr-actions `assemble`, the
 * same check the queue's Submit to OTR runs; it only caches the result on the row).
 * Re-asked whenever the set of rows changes or `version` moves after a batch.
 */
import { useEffect, useMemo, useState } from 'react'
import { previewFactorReady, graphqlErrorText } from '@/lib/apiClient'
import { assembleInvoice } from '@/lib/otrClient'
import { OTR_FIELD_LABEL } from '@/lib/otrInvoice'
import type { ArQueueRow } from './arQueue'

export interface FactorReadiness {
  /** The customer is billed through the factor; false rows keep the normal invoice flow. */
  factorBilled: boolean
  ready: boolean
  missing: string[]
}

const PAGE = 50

type Entry = [string, FactorReadiness]
const entry = (key: string, r: FactorReadiness): Entry => [key, r]

export function useFactorReadiness(rows: readonly ArQueueRow[], enabled: boolean, version = 0): Map<string, FactorReadiness> {
  const [byKey, setByKey] = useState<Map<string, FactorReadiness>>(new Map())
  const orderRows = useMemo(() => rows.filter((r) => !r.factorItem), [rows])
  const queueRows = useMemo(() => rows.filter((r) => r.factorItem), [rows])
  const signature = useMemo(() => rows.map((r) => r.key).sort().join(','), [rows])

  useEffect(() => {
    if (!enabled || !signature) return
    let alive = true
    const orderIds = [...new Set(orderRows.map((r) => r.orderId))]
    const pages: string[][] = []
    for (let i = 0; i < orderIds.length; i += PAGE) pages.push(orderIds.slice(i, i + PAGE))
    const keyOfOrder = new Map(orderRows.map((r) => [r.orderId, r.key]))

    const orderWork = pages.map((orderIds) => previewFactorReady({ orderIds })
      .then(({ results }) => results.map((r) => entry(keyOfOrder.get(r.orderId) ?? `order:${r.orderId}`, { factorBilled: r.factorBilled, ready: r.ready, missing: r.missing })))
      .catch((err: unknown) => orderIds.map((id) => entry(keyOfOrder.get(id) ?? `order:${id}`, { factorBilled: false, ready: false, missing: [graphqlErrorText(err) || 'Could not check'] }))))
    const queueWork = queueRows.map((row) => {
      const item = row.factorItem!
      return assembleInvoice(item.id)
        .then((r) => {
          const missing = [...r.missingFields.map((f) => OTR_FIELD_LABEL[f]), ...r.missingDocuments]
          if (item.otrError) missing.push(item.otrError)
          // Already at OTR with documents to resend: ready once the documents are in.
          const ready = item.otrInvoiceId ? r.missingDocuments.length === 0 : r.missingFields.length === 0 && r.missingDocuments.length === 0
          return [entry(row.key, { factorBilled: true, ready, missing: ready ? [] : missing })]
        })
        .catch((err: unknown) => [entry(row.key, { factorBilled: true, ready: false, missing: [graphqlErrorText(err) || 'Could not check'] })])
    })

    Promise.all([...orderWork, ...queueWork]).then((sets) => {
      if (alive) setByKey(new Map(sets.flat()))
    })
    return () => { alive = false }
    // orderRows/queueRows follow `signature`; version re-asks after a batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, version])

  return byKey
}
