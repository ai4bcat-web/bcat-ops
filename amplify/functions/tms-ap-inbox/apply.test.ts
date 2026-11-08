import { describe, expect, it } from 'vitest'
import { BILL_AUDIT_COLUMNS, BILL_WRITABLE_COLUMNS } from '../../../src/lib/apInbox/applyPlan'
import { decide, rankCandidates } from '../../../src/lib/apInbox/match'
import { fxAssignment, fxBill, fxExtraction, fxVendor } from '../../../src/lib/apInbox/fixtures'
import { resolveApInboxConfig } from '../../../src/lib/apInbox/constants'
import { applyAuto, applyHuman, dismiss, markCreated, revert } from './apply'
import { makeItem, makeKit, NOW } from './actionsTestkit'
import { createVendorBill } from './vendorBill'

const cfg = resolveApInboxConfig({})

async function autoDecision(kit: ReturnType<typeof makeKit>, ext = fxExtraction()) {
  const ledger = await kit.deps.store.loadLedger()
  const d = decide(ext, rankCandidates(ext, ledger), ledger, cfg, { autoApplied: 0 })
  return d
}

const changedKeys = (a: object, b: object) =>
  Object.keys({ ...a, ...b }).filter((k) => JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k]))

describe('applyAuto', () => {
  it('writes only the allow-listed columns of a placeholder bill, files the e-mail and closes the item', async () => {
    const kit = makeKit()
    const d = await autoDecision(kit)
    expect(d.outcome).toBe('AUTO')
    const before = structuredClone(kit.mem.bills.get('bill-1')!)
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)

    const out = await applyAuto(kit.deps, item, d, NOW)

    expect(out.status).toBe('APPLIED')
    expect(out.wroteFields).toBe(true)
    const after = kit.mem.bills.get('bill-1')!
    const allowed = new Set<string>([...BILL_WRITABLE_COLUMNS, ...BILL_AUDIT_COLUMNS])
    expect(changedKeys(before, after).every((k) => allowed.has(k))).toBe(true)
    expect(after).toMatchObject({ billNumber: 'SH-5521', billDate: '2026-11-03', billMonth: '2026-11', dueAt: '2026-12-03', billedCents: 150_050, status: 'IN_REVIEW', grossCents: 150_000, apInboxItemId: 'apin:m1' })
    expect(out.item).toMatchObject({ status: 'APPLIED', reviewReason: null, resolvedBy: 'ap-inbox' })
    expect(out.item.ttlEpoch).toBe(Math.floor(NOW.getTime() / 1000) + 180 * 86_400)
    expect(out.item.applied).toMatchObject({ mode: 'AUTO', before: { billNumber: null, version: 3 }, after: { billNumber: 'SH-5521', version: 4 } })
    expect(kit.mem.documents.map((x) => [x.shipmentId, x.type, x.sourceRef])).toEqual([['shp-1', 'CARRIER_INVOICE', 'ap-inbox:apin:m1'], ['shp-1', 'CARRIER_INVOICE', 'ap-inbox:apin:m1']])
    expect(out.item.attachments?.every((a) => a.documentId)).toBe(true)
    const audit = kit.mem.audits.find((a) => a.action === 'AP_INBOX_APPLIED')!
    expect(audit.changes).toMatchObject({ itemId: 'apin:m1', messageUrl: item.sourceUrl, fields: expect.arrayContaining(['billNumber']) })
    expect(JSON.stringify(kit.mem.audits)).not.toContain('Dear')
  })

  it('does not write the amount of a TO_BE_PAID bill', async () => {
    const kit = makeKit({ bills: [fxBill({ status: 'TO_BE_PAID' })] })
    const d = await autoDecision(kit)
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    await applyAuto(kit.deps, item, d, NOW)
    expect(kit.mem.bills.get('bill-1')).toMatchObject({ billNumber: 'SH-5521', billedCents: 150_000 })
  })

  it('a refused conditional write leaves the bill alone and queues CHANGED_UNDERFOOT', async () => {
    const kit = makeKit()
    const d = await autoDecision(kit)
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    kit.deps.store.updateCarrierBill = async () => null // someone edited between read and write
    const before = structuredClone(kit.mem.bills.get('bill-1')!)

    const out = await applyAuto(kit.deps, item, d, NOW)

    expect(out.status).toBe('CHANGED_UNDERFOOT')
    expect(kit.mem.bills.get('bill-1')).toEqual(before)
    expect(out.item).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'CHANGED_UNDERFOOT' })
    expect(kit.mem.audits).toHaveLength(0)
  })

  it('a bill that gained a typed invoice number since the ledger was read is not overwritten', async () => {
    const kit = makeKit()
    const d = await autoDecision(kit)
    kit.mem.bills.get('bill-1')!.billNumber = 'TYPED-1'
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const out = await applyAuto(kit.deps, item, d, NOW)
    expect(out.status).toBe('CHANGED_UNDERFOOT')
    expect(kit.mem.bills.get('bill-1')!.billNumber).toBe('TYPED-1')
  })

  it('a bill that already carries the item id (crash after the write) is closed without a second write', async () => {
    const kit = makeKit({ bills: [fxBill({ apInboxItemId: 'apin:m1', billNumber: 'SH-5521' })] })
    const d = await autoDecision(kit)
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const out = await applyAuto(kit.deps, item, d, NOW)
    expect(out).toMatchObject({ status: 'APPLIED', wroteFields: false })
    expect(kit.mem.bills.get('bill-1')!.version).toBe(3)
  })

  it('fills the blanks of a vendor payable', async () => {
    const ext = fxExtraction({ issuer: { name: 'Acme Tire Co', kind: 'VENDOR', mc: null, dot: null }, pros: [], invoiceNumber: 'AT-7781', invoiceDate: '2026-11-02', dueDate: '2026-12-02', amountCents: 48_000 })
    const kit = makeKit({ bills: [], vendors: [fxVendor()] })
    const d = await autoDecision(kit, ext)
    expect(d.outcome).toBe('AUTO')
    const item = makeItem({ extraction: ext })
    await kit.mem.store.putItemIfAbsent(item)
    const out = await applyAuto(kit.deps, item, d, NOW)
    expect(out.item.status).toBe('APPLIED')
    expect(kit.mem.vendors.get('vp-1')).toMatchObject({ invoiceDate: '2026-11-02', dueDate: '2026-12-02', amount: 48_000, apInboxItemId: 'apin:m1' })
    expect(kit.mem.vendors.get('vp-1')!.attachments).toHaveLength(2)
  })
})

describe('applyHuman + revert', () => {
  it('writes a conflict only when the reviewer ticks it, and revert restores the exact prior values', async () => {
    const kit = makeKit({ bills: [fxBill({ billNumber: 'OLD-1', billDate: '2026-10-30', billMonth: '2026-10', dueAt: '2026-11-29' })] })
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const original = structuredClone(kit.mem.bills.get('bill-1')!)

    const res = await applyHuman(kit.deps, item, { target: { kind: 'CARRIER_BILL', id: 'bill-1' }, picks: { billNumber: false, billDate: true, dueAt: true, billedCents: false } }, 'rep@bcatcorp.com')

    expect(res.fields).toEqual(['billDate', 'dueAt'])
    expect(kit.mem.bills.get('bill-1')).toMatchObject({ billNumber: 'OLD-1', billDate: '2026-11-03', billMonth: '2026-11', dueAt: '2026-12-03' })
    expect(res.item).toMatchObject({ status: 'LINKED', resolvedBy: 'rep@bcatcorp.com' })

    const reverted = await revert(kit.deps, res.item, 'rep@bcatcorp.com')
    const now = kit.mem.bills.get('bill-1')!
    expect(now).toMatchObject({ billNumber: original.billNumber, billDate: original.billDate, billMonth: original.billMonth, dueAt: original.dueAt, billedCents: original.billedCents })
    expect(now.apInboxItemId).toBeNull()
    expect(reverted).toMatchObject({ status: 'NEEDS_REVIEW', applied: null, target: null, ttlEpoch: null })
    expect(kit.mem.audits.map((a) => a.action)).toEqual(['AP_INBOX_LINKED', 'AP_INBOX_REVERTED'])
  })

  it('revert restores a blank invoice number as blank and is refused after any later edit', async () => {
    const kit = makeKit()
    const d = await autoDecision(kit)
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const { item: applied } = await applyAuto(kit.deps, item, d, NOW)

    kit.mem.bills.get('bill-1')!.version += 1 // a later edit by a person
    await expect(revert(kit.deps, applied, 'rep@bcatcorp.com')).rejects.toThrow(/^The bill changed since/)
    expect(kit.mem.bills.get('bill-1')!.billNumber).toBe('SH-5521')

    kit.mem.bills.get('bill-1')!.version -= 1
    await revert(kit.deps, applied, 'rep@bcatcorp.com')
    expect((kit.mem.bills.get('bill-1')!.billNumber ?? '').trim()).toBe('')
    expect(kit.mem.bills.get('bill-1')!.billedCents).toBe(150_000)
  })

  it('a credit memo is only filed, never written onto the bill', async () => {
    const kit = makeKit()
    const item = makeItem({ kind: 'CREDIT_MEMO', extraction: fxExtraction({ kind: 'CREDIT_MEMO' }) })
    await kit.mem.store.putItemIfAbsent(item)
    const before = structuredClone(kit.mem.bills.get('bill-1')!)
    const res = await applyHuman(kit.deps, item, { target: { kind: 'CARRIER_BILL', id: 'bill-1' } }, 'rep@bcatcorp.com')
    expect(res.fields).toEqual([])
    expect(kit.mem.bills.get('bill-1')).toEqual(before)
    expect(res.item.status).toBe('LINKED')
    expect(kit.mem.documents).toHaveLength(2)
  })

  it('a stale diff (bill version moved since the preview) is refused with nothing written', async () => {
    const kit = makeKit()
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    await expect(applyHuman(kit.deps, item, { target: { kind: 'CARRIER_BILL', id: 'bill-1' }, expectedVersion: 2 }, 'rep@bcatcorp.com')).rejects.toThrow(/changed since you opened/)
    expect(kit.mem.bills.get('bill-1')!.billNumber).toBeNull()
    expect((await kit.mem.store.getItem('apin:m1'))!.status).toBe('NEEDS_REVIEW')
  })

  it('linking an awaiting assignment files the PDF and writes no AP row', async () => {
    const kit = makeKit({ bills: [], assignments: [fxAssignment()] })
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const res = await applyHuman(kit.deps, item, { target: { kind: 'LOAD_CARRIER', id: 'lc-9' } }, 'rep@bcatcorp.com')
    expect(res.fields).toEqual([])
    expect(kit.mem.documents.every((x) => x.shipmentId === 'shp-9')).toBe(true)
    expect(kit.mem.bills.size).toBe(0)
  })

  it('an already-handled item cannot be linked again', async () => {
    const kit = makeKit()
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    await applyHuman(kit.deps, item, { target: { kind: 'CARRIER_BILL', id: 'bill-1' } }, 'a@bcatcorp.com')
    const fresh = (await kit.mem.store.getItem('apin:m1'))!
    await expect(applyHuman(kit.deps, fresh, { target: { kind: 'CARRIER_BILL', id: 'bill-1' } }, 'b@bcatcorp.com')).rejects.toThrow(/already handled/)
  })
})

describe('dismiss / markCreated / createVendorBill', () => {
  it('dismiss deletes the stored objects, sets the short TTL and audits', async () => {
    const kit = makeKit()
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const out = await dismiss(kit.deps, item, 'NOT_INVOICE', 'newsletter', 'rep@bcatcorp.com')
    expect(kit.fakes.deleted.sort()).toEqual(['intake-pdfs/ap-inbox/h1/0-inv.pdf', 'intake-pdfs/ap-inbox/h1/email.txt'])
    expect(out).toMatchObject({ status: 'DISMISSED', dismissReason: 'NOT_INVOICE: newsletter', attachments: [] })
    expect(out.ttlEpoch).toBe(Math.floor(NOW.getTime() / 1000) + 30 * 86_400)
    expect(kit.mem.audits[0]).toMatchObject({ action: 'AP_INBOX_DISMISSED', entityId: 'apin:m1' })
  })

  it('dismiss keeps objects already filed on a shipment (they are bill documents now)', async () => {
    const kit = makeKit()
    const item = makeItem({ attachments: [{ key: 'k1', name: 'a.pdf', contentType: 'application/pdf', size: 1, documentId: 'doc-1' }, { key: 'k2', name: 'b.pdf', contentType: 'application/pdf', size: 1 }] })
    await kit.mem.store.putItemIfAbsent(item)
    const out = await dismiss(kit.deps, item, 'DUPLICATE', undefined, 'rep@bcatcorp.com')
    expect(kit.fakes.deleted).toEqual(['k2'])
    expect(out.attachments).toHaveLength(1)
  })

  it('markCreated closes the item against the bill the browser recorded and refuses an unknown bill', async () => {
    const kit = makeKit()
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    await expect(markCreated(kit.deps, item, 'nope', 'rep@bcatcorp.com')).rejects.toThrow(/not found/)
    const out = await markCreated(kit.deps, item, 'bill-1', 'rep@bcatcorp.com')
    expect(out).toMatchObject({ status: 'CREATED', target: { kind: 'CARRIER_BILL', id: 'bill-1' } })
    expect(kit.mem.bills.get('bill-1')!.version).toBe(3)
  })

  it('createVendorBill creates a NEED_TO_PAY payable once, even when retried', async () => {
    const kit = makeKit()
    const item = makeItem()
    await kit.mem.store.putItemIfAbsent(item)
    const input = { vendor: 'Acme Tire Co', invoiceNumber: 'AT-1', invoiceDate: '2026-11-02', dueDate: '2026-12-02', amountCents: 9900, description: 'tires' }
    const out = await createVendorBill(kit.deps, item, input, 'rep@bcatcorp.com')
    expect(out.vendorPayableId).toBe('vp-apin:m1')
    expect(kit.mem.vendors.get(out.vendorPayableId)).toMatchObject({ status: 'NEED_TO_PAY', source: 'EMAIL', amount: 9900, apInboxItemId: 'apin:m1' })
    expect(out.item).toMatchObject({ status: 'CREATED', target: { kind: 'VENDOR_PAYABLE' } })
    await expect(createVendorBill(kit.deps, out.item, input, 'rep@bcatcorp.com')).rejects.toThrow(/already handled/)
    expect(kit.mem.vendors.size).toBe(1)
  })
})
