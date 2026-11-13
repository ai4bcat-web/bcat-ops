import { describe, expect, it } from 'vitest'
import { decodeNoticeTag, encodeNoticeTag, foldDelivery, parseSesEvent, type NoticeDelivery } from './deliveryEvent'
import { recordDelivery, type Deps } from './handler'

const tag = encodeNoticeTag('inv:20027:2')

function sesEvent(eventType: string, extra: Record<string, unknown>, tags: Record<string, string[]> = { noticeId: [tag] }) {
  return { 'detail-type': 'x', detail: { eventType, mail: { messageId: 'm-1', timestamp: '2026-11-13T05:00:00.000Z', tags }, ...extra } }
}

const delivered = sesEvent('Delivery', { delivery: { timestamp: '2026-11-13T05:00:02.000Z', recipients: ['royalinvoices@teamtrg.com'] } })
const bounced = sesEvent('Bounce', {
  bounce: {
    bounceType: 'Permanent', bounceSubType: 'General', timestamp: '2026-11-13T05:00:03.000Z',
    bouncedRecipients: [{ emailAddress: 'invoices@bcatcorp.com', diagnosticCode: 'smtp; 550 5.7.1 rejected by DMARC policy' }],
  },
})

describe('notice tags', () => {
  it('round-trip ids with colons through SES-safe characters', () => {
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeNoticeTag(tag)).toBe('inv:20027:2')
  })
})

describe('parseSesEvent', () => {
  it('reads a delivery', () => {
    expect(parseSesEvent(delivered.detail)).toEqual({
      noticeId: 'inv:20027:2', messageId: 'm-1',
      entry: { type: 'DELIVERED', at: '2026-11-13T05:00:02.000Z', recipients: ['royalinvoices@teamtrg.com'], reason: null },
    })
  })

  it('reads a bounce with its reason', () => {
    const parsed = parseSesEvent(bounced.detail)
    expect(parsed?.entry.type).toBe('BOUNCED')
    expect(parsed?.entry.recipients).toEqual(['invoices@bcatcorp.com'])
    expect(parsed?.entry.reason).toContain('550 5.7.1')
  })

  it('ignores events it does not record', () => {
    expect(parseSesEvent({ eventType: 'Send', mail: {} })).toBeNull()
    expect(parseSesEvent({ eventType: 'Open', mail: {} })).toBeNull()
  })
})

describe('foldDelivery', () => {
  it('lets the worst outcome win across recipients', () => {
    const one = foldDelivery(null, parseSesEvent(delivered.detail)!.entry)
    const two = foldDelivery(one, parseSesEvent(bounced.detail)!.entry)
    expect(two.deliveryStatus).toBe('BOUNCED')
    expect(two.deliveredAt).toBe('2026-11-13T05:00:02.000Z')
    expect(two.deliveryError).toContain('invoices@bcatcorp.com')
    expect(two.deliveryLog).toHaveLength(2)
    // A later delivery does not hide the bounce.
    expect(foldDelivery(two, parseSesEvent(delivered.detail)!.entry).deliveryStatus).toBe('BOUNCED')
  })

  it('replaces a delay with the delivery that follows it', () => {
    const delayed = foldDelivery(null, { type: 'DELAYED', at: 't1', recipients: ['a@x.com'], reason: 'TransientCommunicationFailure' })
    expect(foldDelivery(delayed, { type: 'DELIVERED', at: 't2', recipients: ['a@x.com'], reason: null }).deliveryStatus).toBe('DELIVERED')
  })
})

function memoryDeps(start: Partial<NoticeDelivery> | null, losses = 0): Deps & { row: Partial<NoticeDelivery> | null } {
  let lose = losses
  const deps = {
    tableName: 'ShipmentNotice-test',
    row: start,
    async get() { return deps.row },
    async put(_id: string, next: NoticeDelivery, _now: string, expected: number) {
      if (lose > 0) { lose--; return false }
      if ((deps.row?.deliveryLog?.length ?? 0) !== expected) return false
      deps.row = next
      return true
    },
  }
  return deps
}

describe('recordDelivery', () => {
  it('writes the outcome onto the tagged notice', async () => {
    const deps = memoryDeps({})
    expect(await recordDelivery(delivered, deps)).toEqual({ recorded: true })
    expect(deps.row?.deliveryStatus).toBe('DELIVERED')
  })

  it('retries when another event for the same e-mail landed first', async () => {
    const deps = memoryDeps({}, 2)
    expect(await recordDelivery(bounced, deps)).toEqual({ recorded: true })
    expect(deps.row?.deliveryStatus).toBe('BOUNCED')
  })

  it('skips mail without a notice tag and notices it cannot find', async () => {
    expect(await recordDelivery(sesEvent('Delivery', { delivery: { recipients: [] } }, {}), memoryDeps({}))).toEqual({ recorded: false, reason: 'no notice tag' })
    expect(await recordDelivery(delivered, memoryDeps(null))).toEqual({ recorded: false, reason: 'notice not found' })
  })
})
