import { describe, expect, it, vi } from 'vitest'
import { recordAllBills } from './recordAllBills'

const carriers = [
  { id: 'lc-1', carrierName: 'Swift', invoiceId: null },
  { id: 'lc-2', carrierName: 'Heartland', invoiceId: null },
  { id: 'lc-3', carrierName: 'Werner', invoiceId: null },
]

describe('recordAllBills', () => {
  it('records each carrier in booking order, one call each', async () => {
    const record = vi.fn(async () => ({}))
    const out = await recordAllBills(carriers, record)
    expect(record.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['lc-1', 'lc-2', 'lc-3'])
    expect(out.map((o) => o.status)).toEqual(['recorded', 'recorded', 'recorded'])
  })

  it('stops at the first refusal, names that carrier with the server sentence, and leaves the rest untried', async () => {
    const record = vi.fn(async (id: string) => { if (id === 'lc-2') throw new Error('Rate con is not signed') })
    const out = await recordAllBills(carriers, record)
    expect(record).toHaveBeenCalledTimes(2)
    expect(out).toEqual([
      { loadCarrierId: 'lc-1', name: 'Swift', status: 'recorded' },
      { loadCarrierId: 'lc-2', name: 'Heartland', status: 'failed', message: 'Rate con is not signed' },
      { loadCarrierId: 'lc-3', name: 'Werner', status: 'skipped' },
    ])
  })

  it('a re-run skips carriers that already have a bill, so only what is left is recorded', async () => {
    const record = vi.fn(async () => ({}))
    const out = await recordAllBills([{ ...carriers[0], invoiceId: 'cb:lc-1:1' }, carriers[1]], record)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('lc-2')
    expect(out.map((o) => o.status)).toEqual(['already', 'recorded'])
  })
})
