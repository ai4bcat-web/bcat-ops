import { describe, it, expect } from 'vitest'

import {
  THREAD_MAILBOX,
  inboxRoleFromAddresses,
  newMessageId,
  replySubject,
  shipmentIdFromAddresses,
  shipmentIdFromMessageId,
  threadKeyFor,
  threadReplyAddress,
  threadSubject,
} from './shipmentThread'

describe('a shipment\'s own reply address', () => {
  it('is a plus address on the bridged mailbox, so no DNS and no new account', () => {
    expect(threadReplyAddress('s-123')).toBe('ai4bcat+tracking.s-123@gmail.com')
    expect(THREAD_MAILBOX).toBe('ai4bcat@gmail.com')
    expect(threadKeyFor('s-123')).toBe('tracking+s-123')
  })

  it('finds the shipment in To:, and in Cc: when somebody replied to all', () => {
    expect(shipmentIdFromAddresses(['dispatch@carrier.com, ai4bcat+tracking.s-9@gmail.com'])).toBe('s-9')
    expect(shipmentIdFromAddresses([null, 'Someone <ai4bcat+tracking.s-9@gmail.com>'])).toBe('s-9')
  })

  it('answers null rather than guessing when no address names a shipment', () => {
    expect(shipmentIdFromAddresses(['dispatch@carrier.com'])).toBeNull()
    expect(shipmentIdFromAddresses([])).toBeNull()
    expect(shipmentIdFromAddresses(['ai4bcat@gmail.com'])).toBeNull()
  })

  it('routes the four Step K inbox plus addresses to their roles', () => {
    expect(inboxRoleFromAddresses(['ai4bcat+quotes@gmail.com'])).toBe('QUOTE')
    expect(inboxRoleFromAddresses(['ai4bcat+tenders@gmail.com'])).toBe('TENDER')
    expect(inboxRoleFromAddresses(['ai4bcat+carriers@gmail.com'])).toBe('CARRIER')
    expect(inboxRoleFromAddresses(['ai4bcat+tracking@gmail.com'])).toBe('TRACKING')
    expect(inboxRoleFromAddresses(['ai4bcat+payroll@gmail.com'])).toBeNull()
  })
})

describe('RFC-5322 headers, so a carrier\'s mail client threads us like anybody', () => {
  it('names the shipment inside the Message-ID, so a stripped plus address still routes', () => {
    const id = newMessageId('s-77', 3)
    expect(id.startsWith('<s.s-77.3.')).toBe(true)
    expect(id.endsWith('@bcatcorp.com>')).toBe(true)
    expect(shipmentIdFromMessageId(id)).toBe('s-77')
  })

  it('does not claim somebody else\'s Message-ID as ours', () => {
    expect(shipmentIdFromMessageId('<CAF=abc123@mail.gmail.com>')).toBeNull()
    expect(shipmentIdFromMessageId(null)).toBeNull()
  })

  it('mints a distinct id per message on the same thread', () => {
    expect(newMessageId('s-77', 1)).not.toBe(newMessageId('s-77', 2))
  })

  it('prefixes Re: exactly once however many rounds the thread runs', () => {
    expect(replySubject('Load S1 — Chicago to Dallas')).toBe('Re: Load S1 — Chicago to Dallas')
    expect(replySubject('Re: Load S1')).toBe('Re: Load S1')
    expect(replySubject('RE: Load S1')).toBe('RE: Load S1')
  })

  it('writes a subject a human can scan', () => {
    expect(threadSubject('S000123', 'Chicago, IL → Dallas, TX')).toBe('Load S000123 — Chicago, IL → Dallas, TX')
    expect(threadSubject('S000123', null)).toBe('Load S000123')
  })
})
