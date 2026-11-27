import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { signSquareBody, squareEventInfo, verifySquareSignature } from './squareWebhook'

const KEY = 'signature-key-1'
const URL = 'https://abc.lambda-url.us-east-1.on.aws/api/webhooks/square'
const BODY = JSON.stringify({ event_id: 'evt-1', type: 'invoice.updated', data: { object: { invoice: { id: 'INV1', invoice_number: '14730' } } } })

describe('verifySquareSignature', () => {
  it('accepts the HMAC-SHA256, base64, of the notification URL followed by the raw body', () => {
    const header = createHmac('sha256', KEY).update(URL + BODY).digest('base64')
    expect(verifySquareSignature({ header, rawBody: BODY, notificationUrl: URL, signatureKey: KEY })).toEqual({ ok: true })
    expect(signSquareBody(KEY, URL, BODY)).toBe(header)
  })

  it('refuses a changed body, a changed URL and a different key', () => {
    const header = signSquareBody(KEY, URL, BODY)
    expect(verifySquareSignature({ header, rawBody: BODY + ' ', notificationUrl: URL, signatureKey: KEY })).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' })
    expect(verifySquareSignature({ header, rawBody: BODY, notificationUrl: URL + '/', signatureKey: KEY })).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' })
    expect(verifySquareSignature({ header, rawBody: BODY, notificationUrl: URL, signatureKey: 'other' })).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('refuses a missing key, a missing URL and a header that is not base64, without comparing anything', () => {
    const header = signSquareBody(KEY, URL, BODY)
    expect(verifySquareSignature({ header, rawBody: BODY, notificationUrl: URL, signatureKey: '' })).toMatchObject({ reason: 'NO_KEY' })
    expect(verifySquareSignature({ header, rawBody: BODY, notificationUrl: ' ', signatureKey: KEY })).toMatchObject({ reason: 'NO_URL' })
    expect(verifySquareSignature({ header: null, rawBody: BODY, notificationUrl: URL, signatureKey: KEY })).toMatchObject({ reason: 'MALFORMED' })
    expect(verifySquareSignature({ header: 'not base64!', rawBody: BODY, notificationUrl: URL, signatureKey: KEY })).toMatchObject({ reason: 'MALFORMED' })
    expect(verifySquareSignature({ header: 'AAAA', rawBody: BODY, notificationUrl: URL, signatureKey: KEY })).toMatchObject({ reason: 'BAD_SIGNATURE' })
  })
})

describe('squareEventInfo', () => {
  it('reads the id, the type and the invoice, and nothing else', () => {
    expect(squareEventInfo(BODY)).toEqual({ eventId: 'evt-1', type: 'invoice.updated', invoiceId: 'INV1', invoiceNumber: '14730' })
  })
  it('says nothing for a body that is not an event', () => {
    expect(squareEventInfo('nope')).toEqual({ eventId: null, type: null, invoiceId: null, invoiceNumber: null })
    expect(squareEventInfo('{}')).toEqual({ eventId: null, type: null, invoiceId: null, invoiceNumber: null })
  })
})
