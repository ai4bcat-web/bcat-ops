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
/** How long one factoring-queue row's readiness check may take before the row says it could not be checked. */
const QUEUE_CHECK_MS = 25_000

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
    // Each answer lands as it arrives, so one slow row never leaves the whole list on "Checking…".
    const land = (entries: Entry[]) => { if (alive && entries.length) setByKey((prev) => { const next = new Map(prev); for (const [k, v] of entries) next.set(k, v); return next }) }
    const COULD_NOT = 'Could not check — reload to try again'

    const orderWork = pages.map((orderIds) => previewFactorReady({ orderIds })
      .then(({ results }) => results.map((r) => entry(keyOfOrder.get(r.orderId) ?? `order:${r.orderId}`, { factorBilled: r.factorBilled, ready: r.ready, missing: r.missing })))
      .catch((err: unknown) => orderIds.map((id) => entry(keyOfOrder.get(id) ?? `order:${id}`, { factorBilled: false, ready: false, missing: [graphqlErrorText(err) || COULD_NOT] })))
      .then(land))
    const queueWork = queueRows.map((row) => {
      const item = row.factorItem!
      // A readiness check that never answers must not hold the row on "Checking…": give up after a while and say so.
      const timeout = new Promise<Entry[]>((resolve) => setTimeout(() => resolve([entry(row.key, { factorBilled: true, ready: false, missing: [COULD_NOT] })]), QUEUE_CHECK_MS))
      const check = assembleInvoice(item.id)
        .then((r) => {
          // Factoring needs the rate confirmation and the POD, plus what OTR's API takes (r.missingFields already leaves out the ZIPs).
          const missing = [...r.missingFields.map((f) => OTR_FIELD_LABEL[f]), ...r.missingDocuments]
          if (item.otrError) missing.push(item.otrError)
          // Already at OTR with documents to resend: ready once the documents are in.
          const ready = item.otrInvoiceId ? r.missingDocuments.length === 0 : r.missingFields.length === 0 && r.missingDocuments.length === 0
          return [entry(row.key, { factorBilled: true, ready, missing: ready ? [] : missing })]
        })
        .catch((err: unknown) => [entry(row.key, { factorBilled: true, ready: false, missing: [graphqlErrorText(err) || COULD_NOT] })])
      return Promise.race([check, timeout]).then(land)
    })

    void Promise.all([...orderWork, ...queueWork])
    return () => { alive = false }
    // orderRows/queueRows follow `signature`; version re-asks after a batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, version])

  return byKey
}
