import { describe, expect, it } from 'vitest'
import {
  assertBolEmailable, bolEmailBody, bolEmailSubject, deliveryLabel, parseEmailBolInput,
} from './bolEmail'

const base = { shipmentId: 'shp-1', documentId: 'sdoc-1', to: ['a@b.com'], party: 'DRIVER' }

describe('parseEmailBolInput', () => {
  it('accepts a minimal valid request and defaults cc/message', () => {
    expect(parseEmailBolInput(base)).toEqual({ ...base, cc: [], message: null })
  })

  it('refuses an address that could inject a header, in to and in cc', () => {
    expect(() => parseEmailBolInput({ ...base, to: ['a@b.com\r\nBcc: x@y.com'] })).toThrow(/to\[0\] must be an email address/)
    expect(() => parseEmailBolInput({ ...base, cc: ['ok@b.com', 'a@b.com,c@d.com'] })).toThrow(/cc\[1\] must be an email address/)
  })

  it('needs a recipient, a known party and at most twenty addresses', () => {
    expect(() => parseEmailBolInput({ ...base, to: [] })).toThrow(/at least one recipient/)
    expect(() => parseEmailBolInput({ ...base, party: 'SHIPPER' })).toThrow()
    expect(() => parseEmailBolInput({ ...base, to: Array.from({ length: 21 }, (_, i) => `u${i}@b.com`) })).toThrow()
  })
})

describe('assertBolEmailable', () => {
  const ok = { id: 'd', shipmentId: 'shp-1', type: 'BOL', status: 'ACTIVE', audience: 'ALL', sizeBytes: 100 }

  it('passes the shipment\'s own ACTIVE plain BOL', () => {
    expect(assertBolEmailable(ok, 'shp-1')).toBe(ok)
  })

  it('refuses a rated (customer) copy with the pointer to Documents → E-mail', () => {
    expect(() => assertBolEmailable({ ...ok, audience: 'CUSTOMER' }, 'shp-1')).toThrow(/customer copy/)
  })

  it.each([
    [{ status: 'SUPERSEDED' }, /current version/],
    [{ status: 'VOID' }, /current version/],
    [{ type: 'POD' }, /Only a bill of lading/],
    [{ audience: 'INTERNAL' }, /not marked for sharing/],
    [{ audience: 'CARRIER' }, /not marked for sharing/],
    [{ shipmentId: 'shp-2' }, /not on this shipment/],
    [{ sizeBytes: 11 * 1024 * 1024 }, /too large/],
  ])('refuses %j', (patch, message) => {
    expect(() => assertBolEmailable({ ...ok, ...patch }, 'shp-1')).toThrow(message)
  })

  it('refuses a missing row', () => {
    expect(() => assertBolEmailable(null, 'shp-1')).toThrow(/not on this shipment/)
  })
})

describe('subject, body and delivery label', () => {
  const stops = [
    { id: 'p', type: 'pickup' }, { id: 'd1', type: 'delivery' }, { id: 'd2', type: 'delivery' },
  ]

  it('numbers deliveries among deliveries only, and is silent for a master or unknown stop', () => {
    expect(deliveryLabel(stops, 'd2')).toBe('Delivery 2')
    expect(deliveryLabel(stops, 'p')).toBeNull()
    expect(deliveryLabel(stops, null)).toBeNull()
    expect(deliveryLabel(stops, 'zzz')).toBeNull()
  })

  it('keeps the subject on one line and carries the ref token', () => {
    const subject = bolEmailSubject('14913\r\nBcc: x@y.com', 'Delivery 2', '[ref shp-1]')
    expect(subject).not.toMatch(/[\r\n]/)
    expect(subject).toBe('Bill of lading 14913 Bcc: x@y.com — Delivery 2 [ref shp-1]')
    expect(bolEmailSubject('14913', null, '[ref shp-1]')).toBe('Bill of lading 14913 [ref shp-1]')
  })

  it('always says the BOL is attached and signs as the sender', () => {
    expect(bolEmailBody(null, 'Dee')).toBe('BOL attached.\r\n\r\n— Dee, BCAT Tracking')
    expect(bolEmailBody('Dock opens at 8.', 'Dee')).toBe('Dock opens at 8.\r\n\r\nBOL attached.\r\n\r\n— Dee, BCAT Tracking')
  })
})
