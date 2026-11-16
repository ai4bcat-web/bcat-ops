import { describe, expect, it } from 'vitest'
import type { FactoringItem } from '@/types'
import { amountOf, otrRejectedStats, pendingOtrStats } from './factoringQueueStats'

const item = (over: Partial<FactoringItem>): FactoringItem => ({
  id: 'f', proNumber: '1', status: 'PENDING_WITH_OTR', subject: '', fromEmail: '', receivedAt: '', messageId: '', createdAt: '', updatedAt: '2026-11-10T12:00:00Z', ...over,
} as FactoringItem)

describe('pendingOtrStats', () => {
  it('totals what is with OTR and how long it has waited', () => {
    const s = pendingOtrStats([
      item({ id: 'a', proNumber: '100', otrSubmittedAt: '2026-11-04T12:00:00Z', otrAmount: 100_000 }),
      item({ id: 'b', proNumber: '200', otrSubmittedAt: '2026-11-12T12:00:00Z', otrAmount: 50_000 }),
      item({ id: 'c', status: 'FACTORED', otrAmount: 900 }),
    ], '2026-11-14')
    expect(s).toEqual({ count: 2, dollars: 1500, avgDaysWaiting: 6, oldest: { proNumber: '100', days: 10 } })
  })
})

describe('otrRejectedStats', () => {
  it('counts rejected rows, their recent reasons, and loads moved to manual this month', () => {
    const s = otrRejectedStats([
      item({ id: 'a', otrError: 'Invalid PO 123', otrAmount: 30_000 }),
      item({ id: 'b', otrError: 'Invalid PO 456', otrAmount: 20_000 }),
      item({ id: 'c', otrError: 'Missing BOL', updatedAt: '2026-09-01T12:00:00Z', otrAmount: 10_000 }),
      item({ id: 'd', status: 'ARCHIVED', otrError: 'Invalid PO 9', updatedAt: '2026-11-11T12:00:00Z', customerId: 'c1' }),
      item({ id: 'e', status: 'ARCHIVED', updatedAt: '2026-11-11T12:00:00Z' }),
    ], '2026-11-14', (i) => (i.id === 'd' ? 'Acme' : ''))
    expect(s.count).toBe(3)
    expect(s.dollars).toBe(600)
    expect(s.topReasons).toEqual([{ reason: 'OTR refused it: Invalid PO #', count: 2 }])
    expect(s.movedToManual).toEqual({ count: 1, customers: ['Acme'] })
  })
})

describe('amountOf', () => {
  it('reads otrAmount as cents and prefers the readiness payload (dollars)', () => {
    expect(amountOf(item({ otrAmount: 26_650 }))).toBe(266.5)
    expect(amountOf(item({ otrAmount: 26_650, otrReadiness: { payload: { InvoiceAmount: 300 } } as never }))).toBe(300)
    expect(amountOf(item({}))).toBe(0)
  })
})
