/**
 * Batch factor from Ready to invoice (Ryne 2026-11-14): factored loads that are Ready to
 * factor go to OTR together and land in Pending with OTR.
 *
 * OTR has no batch endpoint. Carrier TMS v2 publishes one invoice per `POST /invoices`
 * (amplify/functions/_shared/otrClient.ts, docs/OTR_API_GAPS.md), with no documented rate
 * limit and no request idempotency key. So a batch is the existing one-load path run
 * once per load, in order, with a pause between loads:
 *
 *   no invoice yet   → BATCH_GENERATE (one call for the batch; it writes no e-mail)
 *   no queue row yet → SEND_TO_FACTOR (writes the OTR queue row, calls nothing outside)
 *   queue row        → otr-actions `submit`, the very call the queue's Submit to OTR makes
 *   at OTR, docs out → otr-actions `uploadDocs` (resend documents) instead of a second submit
 *
 * Never twice: a row already Pending with OTR / Factored is skipped, `submit` refuses a row
 * that holds an OTR invoice id, and OTR answers a repeat create for the same invoice number
 * with 409 and the existing invoice, which the client carries on with. A failure stops only
 * its own load; the rest go on, and every load reports what happened to it. Re-running the
 * batch after a failure picks each load up where it stopped.
 *
 * Pure orchestration over injected calls, so the tests run it without touching OTR.
 */

export interface BatchFactorRow {
  key: string
  /** The order, for BATCH_GENERATE; null on a queue row with no order behind it. */
  orderId: string | null
  label: string
  invoiceId: string | null
  factoringItemId: string | null
  /** The queue row's status and OTR invoice id, when there is one. */
  queueStatus?: string | null
  otrInvoiceId?: string | null
}

export type BatchFactorOutcome =
  | { key: string; label: string; ok: true; step: 'submitted' | 'documents'; message: string }
  | { key: string; label: string; ok: false; skipped?: boolean; step: BatchFactorStep; message: string }

export type BatchFactorStep = 'generate' | 'queue' | 'submit' | 'documents' | 'skip'

export interface BatchFactorDeps {
  generate: (orderIds: string[]) => Promise<{ results: { orderId: string; invoiceId?: string; error?: string; releaseGate?: { ok: boolean; missing: { message: string }[] } }[] }>
  sendToFactor: (invoiceId: string) => Promise<{ factoringItem: { id: string } }>
  submit: (factoringItemId: string) => Promise<{ invoiceId: number | string; documentErrors: string[] }>
  uploadDocs: (factoringItemId: string) => Promise<{ invoiceId: number | string; documentErrors: string[] }>
  /** Between loads; OTR publishes no rate limit, so a batch never fires them back to back. */
  pause: () => Promise<void>
  onProgress?: (done: number, total: number) => void
}

/** The most loads one batch sends: the BATCH_GENERATE cap, and a few minutes of OTR at most. */
export const BATCH_FACTOR_LIMIT = 25
export const BATCH_FACTOR_PAUSE_MS = 1500

const DONE_STATUSES = new Set(['PENDING_WITH_OTR', 'FACTORED'])

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function docsMessage(errors: readonly string[]): string {
  return `At OTR, but documents did not all arrive: ${errors.join('; ')}. It stays in Ready to invoice; run Factor again to resend them.`
}

export async function runBatchFactor(rows: readonly BatchFactorRow[], deps: BatchFactorDeps): Promise<BatchFactorOutcome[]> {
  const out: BatchFactorOutcome[] = []
  const invoiceFor = new Map<string, string>()

  // One BATCH_GENERATE for every load still without an invoice. A refusal fails that load only.
  const toGenerate = rows.filter((r) => !r.invoiceId && !r.factoringItemId && r.orderId).map((r) => r.orderId as string)
  const generateRefused = new Map<string, string>()
  if (toGenerate.length > 0) {
    try {
      const { results } = await deps.generate(toGenerate)
      for (const r of results) {
        if (r.invoiceId) invoiceFor.set(r.orderId, r.invoiceId)
        else {
          const reasons = r.releaseGate && !r.releaseGate.ok ? r.releaseGate.missing.map((m) => m.message).join('; ') : r.error
          generateRefused.set(r.orderId, reasons || 'The invoice could not be generated')
        }
      }
    } catch (err) {
      for (const id of toGenerate) generateRefused.set(id, errorText(err))
    }
  }

  let first = true
  for (const row of rows) {
    const base = { key: row.key, label: row.label }
    if (row.queueStatus && DONE_STATUSES.has(row.queueStatus)) {
      out.push({ ...base, ok: false, skipped: true, step: 'skip', message: 'Already with OTR; skipped.' })
      deps.onProgress?.(out.length, rows.length)
      continue
    }
    if (!first) await deps.pause()
    first = false
    try {
      // Already at OTR with documents missing: resend them, never create a second invoice.
      if (row.factoringItemId && row.otrInvoiceId) {
        const res = await deps.uploadDocs(row.factoringItemId)
        out.push(res.documentErrors.length
          ? { ...base, ok: false, step: 'documents', message: docsMessage(res.documentErrors) }
          : { ...base, ok: true, step: 'documents', message: `Documents sent to OTR invoice ${res.invoiceId}.` })
        continue
      }
      let itemId = row.factoringItemId
      if (!itemId) {
        const invoiceId = row.invoiceId ?? (row.orderId ? invoiceFor.get(row.orderId) : undefined)
        if (!invoiceId) {
          out.push({ ...base, ok: false, step: 'generate', message: (row.orderId && generateRefused.get(row.orderId)) || 'No invoice to factor.' })
          continue
        }
        try {
          itemId = (await deps.sendToFactor(invoiceId)).factoringItem.id
        } catch (err) {
          out.push({ ...base, ok: false, step: 'queue', message: errorText(err) })
          continue
        }
      }
      const res = await deps.submit(itemId)
      out.push(res.documentErrors.length
        ? { ...base, ok: false, step: 'documents', message: docsMessage(res.documentErrors) }
        : { ...base, ok: true, step: 'submitted', message: `Submitted to OTR as invoice ${res.invoiceId}.` })
    } catch (err) {
      out.push({ ...base, ok: false, step: 'submit', message: errorText(err) })
    } finally {
      deps.onProgress?.(out.length, rows.length)
    }
  }
  return out
}

export const sleep = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms))
