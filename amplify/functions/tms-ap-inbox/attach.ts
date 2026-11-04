/**
 * Step AG §6.5 / D10 — file an item's stored objects with its target, without touching any AP
 * column: a PENDING `CARRIER_INVOICE` pointer row on the shipment (bill or assignment target), or
 * the payable's `attachments` (vendor target). Idempotent: an attachment that already carries a
 * `documentId` is skipped, so a retry or a second link never files a file twice.
 */
import type { ApInboxAttachmentRef, ApInboxItemRecord, ApInboxTarget } from '../../../src/lib/apInbox/types'
import type { ApInboxDeps } from './contract'

/** Marker stored in `documentId` for files appended to a VendorPayable (no ShipmentDocument row). */
export const VENDOR_ATTACH_MARK = 'vp:'

type Deps = Pick<ApInboxDeps, 'store'>

async function shipmentOf(deps: Deps, target: ApInboxTarget): Promise<string | null> {
  if (target.shipmentId) return target.shipmentId
  if (target.kind === 'CARRIER_BILL') return (await deps.store.getBill(target.billId ?? target.id))?.shipmentId ?? null
  if (target.kind === 'LOAD_CARRIER') return (await deps.store.getAssignment(target.loadCarrierId ?? target.id))?.shipmentId ?? null
  return null
}

/** Persist new `documentId`s on the item; one retry against a concurrent version bump. */
async function saveAttachments(deps: Deps, item: ApInboxItemRecord, marks: Map<string, string>): Promise<ApInboxItemRecord> {
  let cur: ApInboxItemRecord | null = item
  for (let attempt = 0; attempt < 2 && cur; attempt += 1) {
    const attachments = (cur.attachments ?? []).map((a): ApInboxAttachmentRef => (marks.has(a.key) && !a.documentId ? { ...a, documentId: marks.get(a.key) } : a))
    const next = await deps.store.updateItem(cur.id, { attachments }, { expectedVersion: cur.version })
    if (next) return next
    cur = await deps.store.getItem(cur.id)
  }
  return cur ?? item
}

export async function attachToTarget(deps: Deps, item: ApInboxItemRecord, target: ApInboxTarget): Promise<ApInboxItemRecord> {
  const pending = (item.attachments ?? []).filter((a) => !a.documentId)
  if (pending.length === 0) return item
  const marks = new Map<string, string>()

  if (target.kind === 'VENDOR_PAYABLE') {
    const id = target.vendorPayableId ?? target.id
    await deps.store.appendVendorAttachments(id, pending.map((a) => ({ key: a.key, name: a.name, contentType: a.contentType, size: a.size })))
    for (const a of pending) marks.set(a.key, `${VENDOR_ATTACH_MARK}${id}`)
  } else {
    const shipmentId = await shipmentOf(deps, target)
    if (!shipmentId) return item
    for (const a of pending) {
      const doc = await deps.store.putShipmentDocument({
        shipmentId,
        type: 'CARRIER_INVOICE',
        s3Key: a.key,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        sourceRef: `ap-inbox:${item.id}`,
      })
      marks.set(a.key, doc.id)
    }
  }
  return saveAttachments(deps, item, marks)
}
