import { describe, expect, it } from 'vitest'
import { fxBill } from '../../../src/lib/apInbox/fixtures'
import { createMemoryStore } from './memoryStore'

const audit = { itemId: 'apin:1', sourceUrl: 'https://mail.google.com/x', at: '2026-11-04T12:00:00Z' }

describe('memory store write paths (the fake S3/S4 test against)', () => {
  it('writes only allow-listed bill columns and stamps provenance', async () => {
    const m = createMemoryStore({ bills: [fxBill()] })
    const set = { billNumber: 'X1', status: 'PAID', paidCents: 5, remitTo: 'evil' } as never
    expect(await m.store.updateCarrierBill('bill-1', set, { expectedVersion: 3, expectedStatus: 'IN_REVIEW', audit })).toEqual({ version: 4 })
    const b = m.bills.get('bill-1')!
    expect(b).toMatchObject({ billNumber: 'X1', status: 'IN_REVIEW', paidCents: 0, apInboxItemId: 'apin:1', updatedBy: 'ap-inbox' })
    expect('remitTo' in b).toBe(false)
  })

  it('refuses a stale version, a changed status, or a bill that has been paid against', async () => {
    const m = createMemoryStore({ bills: [fxBill(), fxBill({ id: 'b2', paidCents: 100 })] })
    const o = { expectedVersion: 3, expectedStatus: 'IN_REVIEW' as const, audit }
    expect(await m.store.updateCarrierBill('bill-1', { billNumber: 'A' }, { ...o, expectedVersion: 2 })).toBeNull()
    expect(await m.store.updateCarrierBill('bill-1', { billNumber: 'A' }, { ...o, expectedStatus: 'TO_BE_PAID' })).toBeNull()
    expect(await m.store.updateCarrierBill('b2', { billNumber: 'A' }, o)).toBeNull()
    expect(m.bills.get('bill-1')!.billNumber).toBeNull()
  })

  it('putItemIfAbsent is the idempotency guard', async () => {
    const m = createMemoryStore()
    const item = { id: 'apin:1', messageId: '1', receivedAt: '2026-11-04T00:00:00Z', kind: 'INVOICE', status: 'NEEDS_REVIEW', version: 1 } as never
    expect(await m.store.putItemIfAbsent(item)).toBe(true)
    expect(await m.store.putItemIfAbsent(item)).toBe(false)
  })

  it('the run lock is stale after the cutoff', async () => {
    const m = createMemoryStore()
    const now = new Date('2026-11-04T12:00:00Z')
    expect(await m.store.claimRun(now, new Date(now.getTime() - 360_000))).toBe(true)
    expect(await m.store.claimRun(new Date(now.getTime() + 60_000), new Date(now.getTime() - 300_000))).toBe(false)
    expect(await m.store.claimRun(new Date(now.getTime() + 600_000), new Date(now.getTime() + 240_000))).toBe(true)
  })
})
