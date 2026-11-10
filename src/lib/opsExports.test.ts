import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listCustomers: vi.fn(), listOpenBills: vi.fn(), listOpenInvoices: vi.fn(), listVendorPayables: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
const csv = vi.hoisted(() => ({ out: [] as string[] }))
vi.mock('@/lib/directoryCsv', async (orig) => ({ ...(await orig<typeof import('@/lib/directoryCsv')>()), downloadCsv: (_n: string, text: string) => { csv.out.push(text) } }))

import { exportOutstandingPayables, exportOutstandingReceivables } from './opsExports'

beforeEach(() => { csv.out = []; Object.values(api).forEach((f) => f.mockReset()) })

describe('ops exports', () => {
  it('receivables: every open invoice with every field and the customer name', async () => {
    api.listOpenInvoices.mockResolvedValue([{ id: 'i1', customerId: 'c1', totalCents: 5000, terms: { days: 30 } }])
    api.listCustomers.mockResolvedValue([{ id: 'c1', name: 'ACME' }])
    expect(await exportOutstandingReceivables()).toBe(1)
    const [head, row] = csv.out[0].split('\r\n')
    expect(head).toBe('id,customerId,totalCents,terms.days,customerName')
    expect(row).toBe('i1,c1,5000,30,ACME')
  })

  it('payables: carrier bills and unpaid vendor bills in one file, paid vendor bills left out', async () => {
    api.listOpenBills.mockResolvedValue([{ id: 'b1', balanceCents: 100 }])
    api.listVendorPayables.mockResolvedValue([{ id: 'v1', status: 'NEED_TO_PAY' }, { id: 'v2', status: 'DONE' }])
    expect(await exportOutstandingPayables()).toBe(2)
    const lines = csv.out[0].split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('payableKind')
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['b1', 'v1'])
  })
})
