import { describe, expect, it } from 'vitest'
import { DELETE_ORDER, SHIPMENT_INDEXED_MODELS, deleteShipments, restoreDeleted, type DeleteStore, type StoreModel } from './shipmentDelete'
import type { Row } from '../_shared/shipmentStore'
import { authorize } from './handler'

const owner = { email: 'ryne@bcatcorp.com', sub: 'owner', groups: [], isAdmin: true }
const admin = { ...owner, email: 'other@bcatcorp.com', groups: ['ADMIN'] }
function fixture(billing = false) {
  const db: Record<string, Row[]> = Object.fromEntries(DELETE_ORDER.map((m) => [m, []]))
  db.Shipment = [{ id: 's', number: '100', loadIds: ['l'] }]
  for (const model of SHIPMENT_INDEXED_MODELS) db[model] = [{ id: model === 'Load' ? 'l' : model === 'LoadCarrier' ? 'lc' : model === 'Order' ? 'o' : model, shipmentId: 's' }]
  db.LoadFinancials = [{ id: 'l', loadId: 'l', shipmentId: 's' }]
  db.LaneRateSample = [{ id: 'lrs:l', loadId: 'l', shipmentId: 's' }]
  db.LegacyAljexRow = [{ id: 'legacy', shipmentId: 's' }]
  if (billing) {
    db.Invoice = [{ id: 'i', shipmentId: 's', totalCents: 100 }]
    db.CarrierBill = [{ id: 'b', loadCarrierId: 'lc' }]
    db.Commission = [{ id: 'c', orderId: 'o' }]
    db.FactoringItem = [{ id: 'f', loadId: 'l' }]
    db.ArPayment = [{ id: 'ar', applications: JSON.stringify([{ invoiceId: 'i', amountCents: 100 }]), unappliedCents: 0 }]
    db.ApPayment = [{ id: 'ap', applications: [{ billId: 'b', amountCents: 50 }], unappliedCents: 0 }]
  }
  const objects = new Map<string, string>()
  const events: string[] = []
  const audit: Row[] = []
  const store: DeleteStore = {
    isOwner: (caller) => caller.email === owner.email,
    getRow: async (model, id) => db[model]?.find((r) => r.id === id) ?? null,
    queryByShipment: async (model, id) => (db[model] ?? []).filter((r) => r.shipmentId === id),
    getRows: async (model: StoreModel, ids) => (db[model] ?? []).filter((r) => ids.includes(String(r.id))),
    scanProjected: async (model) => db[model] ?? [],
    deleteRows: async (model, ids) => { events.push(`delete:${model}`); db[model] = db[model].filter((r) => !ids.includes(String(r.id))) },
    finishDelete: async (shipment, actor, changes) => {
      await store.deleteRows('Shipment', [String(shipment.id)])
      await store.writeAudit('SHIPMENT', String(shipment.id), 'DELETE_SHIPMENT', actor, changes)
    },
    putIfAbsent: async (model, row) => {
      if (db[model].some((r) => r.id === row.id)) return 'exists'
      db[model].push(row)
      return 'put'
    },
    putObject: async (key, body) => { events.push(`export:${key}`); objects.set(key, body) },
    getObject: async (key) => { events.push(`verify:${key}`); const body = objects.get(key); if (body == null) throw new Error('missing'); return body },
    writeAudit: async (entityType, entityId, action, _actor, changes) => { audit.push({ entityType, entityId, action, changes }) },
    now: () => '2026-11-09T12:00:00.000Z', randomId: () => 'abcdef',
  }
  return { db, store, objects, events, audit }
}
const input = { shipmentIds: ['s'], confirm: 'DELETE' }

describe('owner-only shipment deletion', () => {
  it('refuses non-owner ADMIN on server for delete and restore, allows shipments staff to void', async () => {
    const identity = { sub: 'a', username: admin.email, claims: { email: admin.email, 'cognito:groups': ['ADMIN'] } }
    await expect(authorize('DELETE_SHIPMENTS', identity)).rejects.toThrow('owner')
    await expect(authorize('RESTORE_DELETED_SHIPMENTS', identity)).rejects.toThrow('owner')
    await expect(authorize('VOID_SHIPMENT', { ...identity, claims: { email: 'staff@bcatcorp.com', 'cognito:groups': ['page-loads'] } })).resolves.toMatchObject({ isAdmin: false })
    await expect(deleteShipments(fixture().store, input, admin)).rejects.toThrow('owner')
  })
  it('requires both typed confirmations on force', async () => {
    await expect(deleteShipments(fixture().store, { ...input, confirm: '' }, owner)).rejects.toThrow('DELETE')
    await expect(deleteShipments(fixture().store, { ...input, force: true }, owner)).rejects.toThrow('FORCE')
  })
  it('refuses all billing including void invoices before any export or delete', async () => {
    const f = fixture(true)
    f.db.Invoice[0].status = 'VOID'
    const result = await deleteShipments(f.store, input, owner)
    expect(result.results[0].outcome).toBe('REFUSED_BILLING')
    expect(result.results[0].billing?.payments.map((p) => p.id)).toEqual(['ar', 'ap'])
    expect(f.events).toEqual([])
    expect(f.db.Shipment[0].id).toBe('s')
  })
  it('exports and verifies all children before removal; force round-trips every table without overwriting existing rows', async () => {
    const f = fixture(true)
    const before = structuredClone(f.db)
    const result = await deleteShipments(f.store, { ...input, force: true, forceConfirm: 'FORCE' }, owner)
    expect(result.deleted).toBe(1)
    for (const model of DELETE_ORDER) expect(f.db[model]).toEqual([])
    const firstDelete = f.events.findIndex((e) => e.startsWith('delete:'))
    expect(f.events.slice(firstDelete).some((e) => e.startsWith('export:') || e.startsWith('verify:'))).toBe(false)
    expect(f.audit.filter((a) => a.action === 'DELETE_SHIPMENT')).toHaveLength(1)
    const restored = await restoreDeleted(f.store, { exportPrefix: result.exportPrefix, dryRun: false }, owner)
    expect(Object.values(restored.tables).every((r) => r.failed === 0)).toBe(true)
    expect(f.db).toEqual(before)
    f.db.Shipment[0].number = 'edited'
    await restoreDeleted(f.store, { exportPrefix: result.exportPrefix, dryRun: false }, owner)
    expect(f.db.Shipment[0].number).toBe('edited')
  })
  it('fails closed when S3 write or verification fails', async () => {
    for (const operation of ['putObject', 'getObject'] as const) {
      const f = fixture()
      f.store[operation] = async () => { throw new Error('S3 unavailable') }
      const result = await deleteShipments(f.store, input, owner)
      expect(result.deleted).toBe(0)
      expect(result.results[0].message).toContain('Nothing deleted')
      expect(f.db.Shipment).toHaveLength(1)
      expect(f.events.some((e) => e.startsWith('delete:'))).toBe(false)
    }
  })
  it('refuses shared payment allocations even with force', async () => {
    const f = fixture(true)
    f.db.ArPayment[0].applications = [{ invoiceId: 'i', amountCents: 100 }, { invoiceId: 'other', amountCents: 200 }]
    const result = await deleteShipments(f.store, { ...input, force: true, forceConfirm: 'FORCE' }, owner)
    expect(result.results[0].message).toContain('offline awPreDelete-style split')
    expect(result.deleted).toBe(0)
    expect(f.events).toEqual([])
  })
  it('reports batch partial failures individually and retains a recovery export', async () => {
    const f = fixture()
    f.db.Shipment.push({ id: 's2', number: '200' })
    const remove = f.store.deleteRows
    f.store.deleteRows = async (model, ids) => { if (ids.includes('s2')) throw new Error('DynamoDB unavailable'); await remove(model, ids) }
    const result = await deleteShipments(f.store, { ...input, shipmentIds: ['s', 'missing', 's2'] }, owner)
    expect(result.results.map((r) => r.outcome)).toEqual(['DELETED', 'NOT_FOUND', 'FAILED'])
    expect(result.exportPrefix).toMatch(/^deletes\//)
    expect(f.db.Shipment.map((r) => r.id)).toEqual(['s2'])
  })
})
