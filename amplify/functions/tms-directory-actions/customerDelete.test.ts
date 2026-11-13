import { describe, it, expect } from 'vitest'
import { deleteCustomer, mergeCustomer, mergedCustomerFields, previewDeleteCustomer, restoreCustomer, type DeleteDeps } from './customerDelete'

type Row = Record<string, unknown>
const INDEX_MODEL: Record<string, string> = {}

function fakeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Map<string, Row>>()
  for (const [model, rows] of Object.entries(seed)) tables.set(model, new Map(rows.map((r) => [String(r.id), { ...r }])))
  const t = (model: string) => {
    if (!tables.has(model)) tables.set(model, new Map())
    return tables.get(model)!
  }
  const audits: { entityId: string; action: string; changes: Row }[] = []
  let clock = 0
  const deps: DeleteDeps = {
    tableOf: (m) => m,
    get: async (table, id) => (t(table).has(id) ? { ...t(table).get(id)! } : null),
    queryIndex: async (table, index, key, value) => { INDEX_MODEL[index] = table; return [...t(table).values()].filter((r) => r[key] === value).map((r) => ({ ...r })) },
    scan: async (table) => [...t(table).values()].map((r) => ({ ...r })),
    updateIf: async (table, id, set, field, expected) => {
      const row = t(table).get(id)
      if (!row) return false
      if ((row[field] ?? null) !== (expected ?? null)) return false
      Object.assign(row, set)
      return true
    },
    remove: async (table, id) => { t(table).delete(id) },
    audit: async (entityId, action, changes) => { audits.push({ entityId, action, changes }) },
    now: () => `2026-11-13T00:00:${String(clock++).padStart(2, '0')}Z`,
  }
  return { deps, tables: t, audits }
}

describe('previewDeleteCustomer', () => {
  it('counts history as blocking and CRM rows / locations as not', async () => {
    const db = fakeDb({
      Customer: [{ id: 'c1', name: 'Acme' }],
      Shipment: [{ id: 's1', customerId: 'c1' }, { id: 's2', customerId: 'other' }],
      Invoice: [{ id: 'i1', customerId: 'c1' }],
      FactoringItem: [{ id: 'f1', customerId: 'c1' }],
      CrmContact: [{ id: 'k1', customerId: 'c1' }],
      Location: [{ id: 'l1', customerIds: ['c1', 'c9'] }],
    })
    const p = await previewDeleteCustomer(db.deps, 'c1')
    const n = (k: string) => p.links.find((l) => l.key === k)!.count
    expect([n('shipments'), n('invoices'), n('factoringItems'), n('crmContacts'), n('locations')]).toEqual([1, 1, 1, 1, 1])
    expect(p.blockingTotal).toBe(3)
    expect(p.canHardDelete).toBe(false)
  })
})

describe('deleteCustomer', () => {
  it('hard-deletes a customer with no history, its CRM rows, and unlinks locations — snapshot first', async () => {
    const db = fakeDb({
      Customer: [{ id: 'c1', name: 'Acme Dup' }, { id: 'c2', name: 'Other', replacementCustomerId: 'c1', updatedAt: 'u' }],
      CrmContact: [{ id: 'k1', customerId: 'c1' }],
      Location: [{ id: 'l1', customerIds: ['c1', 'c9'], customerId: 'c1', updatedAt: 'x' }],
    })
    await deleteCustomer(db.deps, 'c1', ' acme dup ')
    expect(db.tables('Customer').has('c1')).toBe(false)
    expect(db.tables('CrmContact').has('k1')).toBe(false)
    expect(db.tables('Location').get('l1')).toMatchObject({ customerIds: ['c9'], customerId: 'c9' })
    expect(db.tables('Customer').get('c2')!.replacementCustomerId).toBeNull()
    expect(db.audits[0]).toMatchObject({ entityId: 'c1', action: 'DELETE_CUSTOMER' })
    expect((db.audits[0].changes.snapshot as Row).customer).toMatchObject({ name: 'Acme Dup' })
  })

  it('refuses when the typed name does not match', async () => {
    const db = fakeDb({ Customer: [{ id: 'c1', name: 'Acme' }] })
    await expect(deleteCustomer(db.deps, 'c1', 'Acme Inc')).rejects.toThrow('Type the customer name')
    expect(db.tables('Customer').has('c1')).toBe(true)
  })

  it('refuses a customer with history', async () => {
    const db = fakeDb({ Customer: [{ id: 'c1', name: 'Acme' }], Order: [{ id: 'o1', customerId: 'c1' }] })
    await expect(deleteCustomer(db.deps, 'c1', 'Acme')).rejects.toThrow('merge it into another customer or archive it')
    expect(db.tables('Customer').has('c1')).toBe(true)
    expect(db.audits).toHaveLength(0)
  })
})

describe('mergeCustomer', () => {
  const seed = () => fakeDb({
    Customer: [
      { id: 'src', name: 'ROYAL GROUP', apEmail: 'ap2@royal.com', noaEmail: 'noa@royal.com', contacts: JSON.stringify([{ name: 'Fab', email: 'fab@royal.com' }]), updatedAt: 'a' },
      { id: 'tgt', name: 'THE ROYAL GROUP', apEmail: 'ap@royal.com', aliases: ['TRG'], contacts: [{ name: 'Al', email: 'al@royal.com' }], updatedAt: 'b' },
    ],
    Shipment: [{ id: 's1', customerId: 'src', customerName: 'ROYAL GROUP' }, { id: 's2', customerId: 'src', customerName: 'Something else' }],
    Load: [{ id: 'ld1', customerId: 'src', customer: 'royal group' }],
    Invoice: [{ id: 'i1', customerId: 'src', customerName: 'ROYAL GROUP', number: '20027', billTo: { name: 'ROYAL GROUP' }, pdfKey: 'k' }],
    ArPayment: [{ id: 'p1', customerId: 'src' }],
    CrmActivity: [{ id: 'a1', customerId: 'src' }],
    Location: [{ id: 'l1', customerIds: ['src', 'tgt'], customerName: 'ROYAL GROUP', updatedAt: 'x' }],
  })

  it('moves every pointer, keeps invoice content, carries addresses over, then deletes the source', async () => {
    const db = seed()
    const out = await mergeCustomer(db.deps, 'src', 'tgt', 'royal group')
    expect(out.status).toBe('DONE')
    expect(db.tables('Shipment').get('s1')).toMatchObject({ customerId: 'tgt', customerName: 'THE ROYAL GROUP' })
    expect(db.tables('Shipment').get('s2')).toMatchObject({ customerId: 'tgt', customerName: 'Something else' })
    expect(db.tables('Load').get('ld1')).toMatchObject({ customerId: 'tgt', customer: 'THE ROYAL GROUP' })
    expect(db.tables('Invoice').get('i1')).toEqual({ id: 'i1', customerId: 'tgt', customerName: 'ROYAL GROUP', number: '20027', billTo: { name: 'ROYAL GROUP' }, pdfKey: 'k' })
    expect(db.tables('ArPayment').get('p1')!.customerId).toBe('tgt')
    expect(db.tables('CrmActivity').get('a1')!.customerId).toBe('tgt')
    expect(db.tables('Location').get('l1')).toMatchObject({ customerIds: ['tgt'], customerName: 'THE ROYAL GROUP' })
    const tgt = db.tables('Customer').get('tgt')!
    expect(tgt.apEmail).toBe('ap@royal.com')
    expect(tgt.apEmailsExtra).toEqual(['ap2@royal.com'])
    expect(tgt.noaEmail).toBe('noa@royal.com')
    expect(tgt.aliases).toEqual(['TRG', 'ROYAL GROUP'])
    expect(JSON.parse(String(tgt.contacts)).map((c: Row) => c.email)).toEqual(['al@royal.com', 'fab@royal.com'])
    expect(db.tables('Customer').has('src')).toBe(false)
    expect(db.audits.map((a) => a.action)).toEqual(['MERGE_CUSTOMER_START', 'MERGE_CUSTOMER'])
  })

  it('stops PARTIAL when out of time and finishes on the next call without redoing the copy', async () => {
    const db = seed()
    let calls = 0
    const out = await mergeCustomer({ ...db.deps, timeLeftMs: () => (calls++ < 1 ? 10_000 : 100) }, 'src', 'tgt', 'ROYAL GROUP')
    expect(out.status).toBe('PARTIAL')
    expect(db.tables('Customer').get('src')!.mergedIntoId).toBe('tgt')
    const again = await mergeCustomer(db.deps, 'src', 'tgt', 'ROYAL GROUP')
    expect(again.status).toBe('DONE')
    expect(db.tables('Customer').has('src')).toBe(false)
    expect(db.tables('Customer').get('tgt')!.apEmailsExtra).toEqual(['ap2@royal.com'])
    expect(db.audits.filter((a) => a.action === 'MERGE_CUSTOMER_START')).toHaveLength(1)
  })

  it('refuses merging into itself, into an archived customer, or without the typed name', async () => {
    const db = seed()
    await expect(mergeCustomer(db.deps, 'src', 'src', 'ROYAL GROUP')).rejects.toThrow('different customer')
    await expect(mergeCustomer(db.deps, 'src', 'tgt', 'nope')).rejects.toThrow('Type the customer name')
    db.tables('Customer').get('tgt')!.active = false
    await expect(mergeCustomer(db.deps, 'src', 'tgt', 'ROYAL GROUP')).rejects.toThrow('archived')
    expect(db.tables('Shipment').get('s1')!.customerId).toBe('src')
  })
})

describe('mergedCustomerFields', () => {
  it('fills only what the target lacks and never aliases the target to itself', () => {
    const out = mergedCustomerFields({ name: 'A', apEmail: '', mcNumber: '123' }, { name: 'a', apEmail: 'x@a.com', mcNumber: '999', aliases: ['A'] })
    expect(out).toEqual({ apEmail: 'x@a.com' })
  })
})

describe('restoreCustomer', () => {
  it('reactivates an archived customer and refuses a merged one', async () => {
    const db = fakeDb({ Customer: [{ id: 'c1', name: 'Acme', active: false, updatedAt: 'u' }, { id: 'c2', name: 'Gone', active: false, mergedIntoId: 'c1' }] })
    const c = await restoreCustomer(db.deps, 'c1')
    expect(c.active).toBe(true)
    await expect(restoreCustomer(db.deps, 'c2')).rejects.toThrow('merged')
  })
})
