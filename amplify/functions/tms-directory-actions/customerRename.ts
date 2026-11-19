import { retargetSearchKey } from '../../../src/lib/invoiceCustomerChange'
import type { DeleteDeps } from './customerDelete'

/**
 * A customer profile rename reaches every record that copied the name (Ryne 2026-11-19:
 * "anything that happens to the customer profile updates that customer name everywhere").
 *
 * Idempotent and resumable: a row whose copy already equals the profile name is skipped, and
 * each write is conditional on the copy still being what was read, so a run cut short by the
 * AppSync limit is finished by calling it again (SYNC_CUSTOMER_NAME).
 *
 * What it never touches: a sent invoice's printed content (billTo snapshot, lines, PDF). The
 * invoice's own customerName label is updated on every invoice so the accounting lists agree
 * with the profile; the billTo name and the stored PDF change only on an invoice nobody has been sent.
 */

interface NameSource {
  key: string
  model: string
  /** GSI on customerId; absent = scan. */
  index?: string
  nameField: string
}

const NAME_SOURCES: readonly NameSource[] = [
  { key: 'shipments', model: 'Shipment', index: 'shipmentsByCustomerIdAndPickupAppt', nameField: 'customerName' },
  { key: 'orders', model: 'Order', index: 'ordersByCustomerIdAndPickupAppt', nameField: 'customerName' },
  { key: 'loads', model: 'Load', index: 'loadsByCustomerId', nameField: 'customer' },
  { key: 'invoices', model: 'Invoice', index: 'invoicesByCustomerIdAndIssuedAt', nameField: 'customerName' },
  { key: 'quotes', model: 'Quote', index: 'quotesByCustomerIdAndQuoteDate', nameField: 'customerName' },
  { key: 'laneRateSamples', model: 'LaneRateSample', nameField: 'customerName' },
  { key: 'commissions', model: 'Commission', nameField: 'customerName' },
  { key: 'trackingLinks', model: 'TrackingLink', nameField: 'customerName' },
]

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

/** True when the invoice has gone to anyone (e-mail, hand-marked, or OTR): its printed bill stays as sent. */
export function invoiceWasSent(inv: Record<string, unknown>): boolean {
  return Boolean(inv.sentAt || inv.markedSentAt || inv.factorSubmittedAt || Number(inv.sentCount ?? 0) > 0)
}

export interface RenameResult {
  status: 'DONE' | 'PARTIAL'
  customerId: string
  name: string
  updated: Record<string, number>
  /** Unsent invoices whose bill-to name changed: their stored PDF is out of date until regenerated. */
  draftInvoiceIds: string[]
}

export async function syncCustomerName(deps: DeleteDeps, customerId: string): Promise<RenameResult> {
  const customer = await deps.get(deps.tableOf('Customer'), customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)
  const name = String(customer.name ?? '').trim()
  if (!name) throw new Error('The customer has no name to copy')

  const updated: Record<string, number> = {}
  const draftInvoiceIds: string[] = []
  const outOfTime = () => (deps.timeLeftMs ? deps.timeLeftMs() < 4000 : false)
  const POOL = 20
  let partial = false

  for (const src of NAME_SOURCES) {
    const table = deps.tableOf(src.model)
    const all = src.index
      ? await deps.queryIndex(table, src.index, 'customerId', customerId)
      : (await deps.scan(table)).filter((r) => r.customerId === customerId)
    const rows = all.filter((r) => r[src.nameField] != null && String(r[src.nameField]).trim() !== name)
    let n = 0
    for (let i = 0; i < rows.length; i += POOL) {
      if (outOfTime()) { partial = true; break }
      const chunk = rows.slice(i, i + POOL)
      const results = await Promise.all(chunk.map(async (row) => {
        const old = row[src.nameField]
        const set: Record<string, unknown> = { [src.nameField]: name }
        if (src.key === 'shipments') {
          set.searchKey = retargetSearchKey(row.searchKey as string | null, old as string, name)
        }
        let draftBill = false
        if (src.key === 'invoices' && !invoiceWasSent(row) && !row.billToId) {
          const billTo = row.billTo as Record<string, unknown> | null | undefined
          if (billTo && typeof billTo === 'object' && norm(billTo.name) === norm(old)) {
            set.billTo = { ...billTo, name }
            draftBill = true
          }
        }
        const ok = await deps.updateIf(table, String(row.id), set, src.nameField, old)
        if (ok && draftBill) draftInvoiceIds.push(String(row.id))
        return ok
      }))
      n += results.filter(Boolean).length
    }
    updated[src.key] = n
    if (partial) break
  }

  // Locations keep a legacy mirror of their first linked customer's name.
  if (!partial) {
    let locs = 0
    const rows = (await deps.scan(deps.tableOf('Location'))).filter((l) => {
      const first = asArray(l.customerIds)[0] ?? l.customerId
      return first === customerId && l.customerName != null && String(l.customerName).trim() !== name
    })
    for (const loc of rows) {
      if (await deps.updateIf(deps.tableOf('Location'), String(loc.id), { customerName: name }, 'customerName', loc.customerName)) locs++
    }
    updated.locations = locs
  }

  const total = Object.values(updated).reduce((a, b) => a + b, 0)
  if (total > 0) {
    await deps.audit(customerId, 'CUSTOMER_NAME_SYNC', { name, updated, draftInvoiceIds, partial })
  }
  return { status: partial ? 'PARTIAL' : 'DONE', customerId, name, updated, draftInvoiceIds }
}
