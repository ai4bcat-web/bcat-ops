import { describe, expect, it } from 'vitest'
import type { DeleteDeps } from './customerDelete'
import { invoiceWasSent, syncCustomerName } from './customerRename'

type Row = Record<string, unknown>

function makeDeps(tables: Record<string, Row[]>, opts: { timeLeft?: () => number } = {}) {
  const audits: Array<{ action: string; changes: Record<string, unknown> }> = []
  const deps: DeleteDeps = {
    tableOf: (m) => m,
    get: async (t, id) => tables[t]?.find((r) => r.id === id) ?? null,
    queryIndex: async (t, _i, key, value) => (tables[t] ?? []).filter((r) => r[key] === value),
    scan: async (t) => tables[t] ?? [],
    updateIf: async (t, id, set, field, expected) => {
      const row = tables[t]?.find((r) => r.id === id)
      if (!row || row[field] !== expected) return false
      Object.assign(row, set)
      return true
    },
    remove: async () => {},
    audit: async (_id, action, changes) => { audits.push({ action, changes }) },
    now: () => '2026-11-19T00:00:00Z',
    timeLeftMs: opts.timeLeft,
  }
  return { deps, audits }
}

const OLD = 'WAREHOUSE SPECIALISTS, LLC'
const NEW = 'WSI Freight Solutions LLC'

describe('syncCustomerName', () => {
  const build = () => ({
    Customer: [{ id: 'c1', name: NEW }],
    Shipment: [
      { id: 's1', customerId: 'c1', customerName: OLD, searchKey: '20088 warehouse specialists, llc elk grove' },
      { id: 's2', customerId: 'other', customerName: 'Other Co' },
    ],
    Order: [{ id: 'o1', customerId: 'c1', customerName: OLD }],
    Load: [{ id: 'l1', customerId: 'c1', customer: OLD }],
    Invoice: [
      { id: 'i-draft', customerId: 'c1', customerName: OLD, billTo: { name: OLD, email: 'a@b.com' } },
      { id: 'i-sent', customerId: 'c1', customerName: OLD, billTo: { name: OLD }, sentAt: '2026-11-01T00:00:00Z' },
      { id: 'i-billto', customerId: 'c1', customerName: OLD, billToId: 'bt1', billTo: { name: 'Some Payer' } },
    ],
    Quote: [], LaneRateSample: [], Commission: [{ id: 'k1', customerId: 'c1', customerName: OLD }], TrackingLink: [],
    Location: [{ id: 'loc1', customerIds: ['c1'], customerName: OLD }, { id: 'loc2', customerIds: ['x', 'c1'], customerName: 'Elsewhere' }],
  }) as Record<string, Row[]>

  it('copies the profile name onto every linked record and only those', async () => {
    const t = build()
    const { deps, audits } = makeDeps(t)
    const out = await syncCustomerName(deps, 'c1')
    expect(out.status).toBe('DONE')
    expect(t.Shipment[0].customerName).toBe(NEW)
    expect(t.Shipment[0].searchKey).toBe('20088 wsi freight solutions llc elk grove')
    expect(t.Shipment[1].customerName).toBe('Other Co')
    expect(t.Order[0].customerName).toBe(NEW)
    expect(t.Load[0].customer).toBe(NEW)
    expect(t.Commission[0].customerName).toBe(NEW)
    expect(t.Location[0].customerName).toBe(NEW)
    expect(t.Location[1].customerName).toBe('Elsewhere')
    expect(out.updated).toMatchObject({ shipments: 1, orders: 1, loads: 1, invoices: 3, commissions: 1, locations: 1 })
    expect(audits[0].action).toBe('CUSTOMER_NAME_SYNC')
  })

  it('changes the printed bill-to only on an unsent invoice that billed the customer itself', async () => {
    const t = build()
    const { deps } = makeDeps(t)
    const out = await syncCustomerName(deps, 'c1')
    const [draft, sent, viaBillTo] = t.Invoice
    expect(draft.customerName).toBe(NEW)
    expect((draft.billTo as Row).name).toBe(NEW)
    expect((draft.billTo as Row).email).toBe('a@b.com')
    expect(sent.customerName).toBe(NEW)
    expect((sent.billTo as Row).name).toBe(OLD)
    expect((viaBillTo.billTo as Row).name).toBe('Some Payer')
    expect(out.draftInvoiceIds).toEqual(['i-draft'])
  })

  it('is idempotent: a second run changes nothing and writes no audit row', async () => {
    const t = build()
    const { deps, audits } = makeDeps(t)
    await syncCustomerName(deps, 'c1')
    audits.length = 0
    const again = await syncCustomerName(deps, 'c1')
    expect(Object.values(again.updated).every((n) => n === 0)).toBe(true)
    expect(audits).toEqual([])
  })

  it('stops with PARTIAL when time runs out so a rerun can finish', async () => {
    const t = build()
    const { deps } = makeDeps(t, { timeLeft: () => 100 })
    const out = await syncCustomerName(deps, 'c1')
    expect(out.status).toBe('PARTIAL')
  })

  it('refuses a customer that does not exist', async () => {
    const { deps } = makeDeps({ Customer: [] })
    await expect(syncCustomerName(deps, 'nope')).rejects.toThrow('Customer not found')
  })
})

describe('invoiceWasSent', () => {
  it('counts e-mailed, hand-marked and OTR-submitted invoices as sent', () => {
    expect(invoiceWasSent({})).toBe(false)
    expect(invoiceWasSent({ sentAt: 'x' })).toBe(true)
    expect(invoiceWasSent({ markedSentAt: 'x' })).toBe(true)
    expect(invoiceWasSent({ factorSubmittedAt: 'x' })).toBe(true)
    expect(invoiceWasSent({ sentCount: 2 })).toBe(true)
  })
})
