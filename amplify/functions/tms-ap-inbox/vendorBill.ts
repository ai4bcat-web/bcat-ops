/**
 * Step AG — AP_INBOX_CREATE_VENDOR_BILL: a vendor (non-carrier) invoice the matcher could not tie to a
 * payable becomes a `VendorPayable` (`source:'EMAIL'`, `NEED_TO_PAY`) from the figures the reviewer
 * confirmed. Carrier invoices never come through here: recording a carrier bill is the human
 * `RECORD_BILL` act in the browser (it finalises charges), reported back via AP_INBOX_MARK_CREATED.
 */
import { ttlEpochFor } from './apply'
import { attachToTarget } from './attach'
import type { ApInboxDeps } from './contract'
import type { ApInboxItemRecord } from '../../../src/lib/apInbox/types'

export interface VendorBillInput {
  vendor: string
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  amountCents: number | null
  description: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function text(v: unknown, name: string, max: number, required = false): string | null {
  if (v == null || v === '') {
    if (required) throw new Error(`${name} is required`)
    return null
  }
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  const t = v.trim()
  if (!t && required) throw new Error(`${name} is required`)
  if (t.length > max) throw new Error(`${name} is too long (max ${max})`)
  return t || null
}

function date(v: unknown, name: string): string | null {
  const t = text(v, name, 10)
  if (t == null) return null
  if (!DATE.test(t) || Number.isNaN(new Date(`${t}T00:00:00Z`).getTime())) throw new Error(`${name} must be a date (YYYY-MM-DD)`)
  return t
}

export function parseVendorBillInput(raw: Record<string, unknown>): VendorBillInput {
  const amount = raw.amountCents
  if (amount != null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 10_000_000_000)) {
    throw new Error('amountCents must be a whole number of cents')
  }
  return {
    vendor: text(raw.vendor, 'vendor', 200, true) as string,
    invoiceNumber: text(raw.invoiceNumber, 'invoiceNumber', 64),
    invoiceDate: date(raw.invoiceDate, 'invoiceDate'),
    dueDate: date(raw.dueDate, 'dueDate'),
    amountCents: (amount as number | null | undefined) ?? null,
    description: text(raw.description, 'description', 500),
  }
}

export async function createVendorBill(
  deps: ApInboxDeps,
  item: ApInboxItemRecord,
  input: VendorBillInput,
  actor: string,
): Promise<{ item: ApInboxItemRecord; vendorPayableId: string }> {
  if (item.status !== 'NEEDS_REVIEW') throw new Error('This e-mail was already handled.')
  if (item.kind !== 'INVOICE') throw new Error('Only invoices can become a vendor bill.')
  if (input.invoiceDate && input.dueDate && input.dueDate < input.invoiceDate) throw new Error('The due date cannot precede the invoice date.')
  const now = deps.now()
  const at = now.toISOString()
  const id = `vp-${item.id}`
  const audit = { itemId: item.id, sourceUrl: item.sourceUrl ?? '', at }
  const created = await deps.store.createVendorPayable(
    {
      id,
      subject: item.subject ?? '',
      vendor: input.vendor,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      amount: input.amountCents,
      description: input.description,
      fromEmail: item.fromEmail ?? null,
      receivedAt: item.receivedAt,
      sourceMessageId: item.messageId,
      attachments: [],
    },
    audit,
  )
  // A retry after a crash finds the payable already there: carry on and close the item.
  if (!created && !(await deps.store.getVendorPayable(id))) throw new Error('The vendor bill could not be created.')
  await deps.store.writeAudit({
    entityType: 'VendorPayable',
    entityId: id,
    action: 'AP_INBOX_VENDOR_BILL_CREATED',
    actor,
    changes: { itemId: item.id, messageUrl: item.sourceUrl ?? null, fields: ['vendor', 'invoiceNumber', 'invoiceDate', 'dueDate', 'amount'].filter((f) => {
      const v = f === 'amount' ? input.amountCents : f === 'vendor' ? input.vendor : (input as unknown as Record<string, unknown>)[f]
      return v != null
    }) },
  })
  const target = { kind: 'VENDOR_PAYABLE' as const, id, vendorPayableId: id }
  const attached = await attachToTarget(deps, item, target)
  const cfg = await deps.store.getConfig()
  const next = await deps.store.updateItem(
    item.id,
    { status: 'CREATED', target, applied: null, reviewReason: null, resolvedAt: at, resolvedBy: actor, ttlEpoch: ttlEpochFor('CREATED', cfg, now) },
    { expectedVersion: attached.version, statusIn: ['NEEDS_REVIEW'] },
  )
  if (!next) throw new Error('This e-mail changed while the vendor bill was being created — reload the queue.')
  return { item: next, vendorPayableId: id }
}
