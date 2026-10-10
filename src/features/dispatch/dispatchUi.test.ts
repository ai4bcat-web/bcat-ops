import { describe, it, expect } from 'vitest'
import { listTime, dayLabel, groupByDay, deliveryLabel, staffName, senderLabel, acceptFiles } from './dispatchUi'
import type { DispatchMessage } from '@/lib/dispatch'

const now = new Date('2026-10-10T20:00:00.000Z')   // 3:00 PM Chicago, a Saturday

describe('times', () => {
  it('shows a clock today, a weekday this week, a date beyond', () => {
    expect(listTime('2026-10-10T19:14:00.000Z', now)).toBe('2:14 PM')
    expect(listTime('2026-10-08T19:14:00.000Z', now)).toBe('Thu')
    expect(listTime('2026-10-01T19:14:00.000Z', now)).toBe('Oct 1')
    expect(listTime(null, now)).toBe('')
  })
  it('labels days', () => {
    expect(dayLabel('2026-10-10T12:00:00.000Z', now)).toBe('Today')
    expect(dayLabel('2026-10-09T12:00:00.000Z', now)).toBe('Yesterday')
    expect(dayLabel('2026-10-02T12:00:00.000Z', now)).toBe('Friday, Oct 2')
  })
  it('groups a thread by Chicago day', () => {
    const m = (id: string, at: string) => ({ id, at, conversationId: 'c', phone: 'p', direction: 'IN', kind: 'SMS' } as DispatchMessage)
    // 04:30Z on the 10th is still the 9th in Chicago.
    const g = groupByDay([m('a', '2026-10-09T18:00:00.000Z'), m('b', '2026-10-10T04:30:00.000Z'), m('c', '2026-10-10T15:00:00.000Z')], now)
    expect(g.map((x) => [x.label, x.messages.length])).toEqual([['Yesterday', 2], ['Today', 1]])
  })
})

describe('deliveryLabel', () => {
  it('reads each outbound state and stays quiet for inbound and notes', () => {
    expect(deliveryLabel({ direction: 'OUT', kind: 'SMS', status: 'delivered' })).toEqual({ text: 'Delivered', tone: 'ok' })
    expect(deliveryLabel({ direction: 'OUT', kind: 'SMS', status: 'queued' })).toEqual({ text: 'Sending…', tone: 'pending' })
    expect(deliveryLabel({ direction: 'OUT', kind: 'SMS', status: 'undelivered', errorMessage: 'The phone is off or unreachable.' })).toEqual({ text: 'Not delivered. The phone is off or unreachable.', tone: 'bad' })
    expect(deliveryLabel({ direction: 'OUT', kind: 'SMS', status: 'failed', errorCode: '30007' })).toEqual({ text: 'Not delivered. Twilio error 30007.', tone: 'bad' })
    expect(deliveryLabel({ direction: 'IN', kind: 'SMS', status: 'received' })).toBeNull()
    expect(deliveryLabel({ direction: 'OUT', kind: 'NOTE', status: 'saved' })).toBeNull()
  })
})

describe('misc', () => {
  it('names staff from their email', () => {
    expect(staffName('jenny@bcatcorp.com')).toBe('Jenny')
    expect(staffName('slack:U123')).toBe('U123')
    expect(staffName(null)).toBe('')
  })
  it('labels who sent an outbound message, and from where', () => {
    expect(senderLabel({ direction: 'OUT', sentBy: 'jenny@bcatcorp.com' }, 'ryne@bcatcorp.com')).toBe('Jenny')
    expect(senderLabel({ direction: 'OUT', sentBy: 'Ryne@bcatcorp.com' }, 'ryne@bcatcorp.com')).toBe('You')
    expect(senderLabel({ direction: 'OUT', sentBy: 'dennis@bcatcorp.com', via: 'slack' }, 'ryne@bcatcorp.com')).toBe('Dennis via Slack')
    expect(senderLabel({ direction: 'IN', sentBy: null }, 'ryne@bcatcorp.com')).toBeNull()
  })
  it('accepts pictures and PDFs under 5 MB, up to five, naming the rest', () => {
    const f = (name: string, type: string, size = 1000) => new File([new Uint8Array(size)], name, { type })
    const r = acceptFiles([f('a.jpg', 'image/jpeg'), f('b.mov', 'video/quicktime'), f('c.pdf', 'application/pdf')])
    expect(r.ok.map((x) => x.name)).toEqual(['a.jpg', 'c.pdf'])
    expect(r.rejected).toEqual(['b.mov (only pictures and PDFs)'])
    const six = Array.from({ length: 6 }, (_, i) => f(`${i}.png`, 'image/png'))
    expect(acceptFiles(six).ok).toHaveLength(5)
    expect(acceptFiles(six).rejected[0]).toContain('limit 5')
    expect(acceptFiles([f('big.jpg', 'image/jpeg', 6 * 1024 * 1024)]).rejected[0]).toContain('over 5 MB')
  })
})
