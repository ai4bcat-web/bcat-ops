import { describe, expect, it, vi } from 'vitest'
import { mcDigits, refreshQueueBrokerMc, rowsToRefresh, type QueueRowLike } from './queueBrokerMc'

const row = (over: Partial<QueueRowLike> & { id: string }): QueueRowLike => ({
  customerId: 'cus-1',
  status: 'NEED_TO_FACTOR',
  otrManualFields: { BrokerMC: '965058', InvoiceNo: '20062' },
  ...over,
})

describe('mcDigits', () => {
  it('compares MCs by digits only', () => {
    expect(mcDigits('MC 0965058')).toBe('965058')
    expect(mcDigits('965058')).toBe('965058')
    expect(mcDigits(null)).toBe('')
  })
})

describe('rowsToRefresh', () => {
  it('picks an open row whose prefilled copy is the old MC', () => {
    expect(rowsToRefresh([row({ id: '20062' })], 'cus-1', '965058', '1620490').map((r) => r.id)).toEqual(['20062'])
  })
  it('matches the old MC however it is written', () => {
    expect(rowsToRefresh([row({ id: 'a', otrManualFields: { BrokerMC: 'MC 965058' } })], 'cus-1', '0965058', '1620490')).toHaveLength(1)
  })
  it('leaves a value a person typed to something else', () => {
    expect(rowsToRefresh([row({ id: 'a', otrManualFields: { BrokerMC: '777' } })], 'cus-1', '965058', '1620490')).toEqual([])
  })
  it('leaves another customer, a submitted row, and a row already past the queue', () => {
    const rows = [
      row({ id: 'other', customerId: 'cus-2' }),
      row({ id: 'sent', otrInvoiceId: '26170636' }),
      row({ id: 'done', status: 'FACTORED' }),
    ]
    expect(rowsToRefresh(rows, 'cus-1', '965058', '1620490')).toEqual([])
  })
  it('does nothing when the MC did not change, was cleared, or had no old value', () => {
    expect(rowsToRefresh([row({ id: 'a' })], 'cus-1', '965058', '0965058')).toEqual([])
    expect(rowsToRefresh([row({ id: 'a' })], 'cus-1', '965058', '')).toEqual([])
    expect(rowsToRefresh([row({ id: 'a', otrManualFields: { BrokerMC: '1620490' } })], 'cus-1', null, '1620490')).toEqual([])
  })
  it('reads a row whose manual fields are stored as JSON text', () => {
    expect(rowsToRefresh([row({ id: 'a', otrManualFields: '{"BrokerMC":"965058"}' })], 'cus-1', '965058', '1620490')).toHaveLength(1)
  })
})

describe('refreshQueueBrokerMc', () => {
  it('writes the new MC against the stored value and reports skipped rows', async () => {
    const setBrokerMc = vi.fn(async (id: string) => id !== 'late')
    const out = await refreshQueueBrokerMc(
      { scanQueue: async () => [row({ id: '20062' }), row({ id: 'late' })], setBrokerMc, now: () => 'now' },
      'cus-1',
      '965058',
      '1620490',
    )
    expect(setBrokerMc).toHaveBeenCalledWith('20062', '965058', '1620490')
    expect(out).toEqual({ refreshed: ['20062'], skipped: ['late'] })
  })
})
