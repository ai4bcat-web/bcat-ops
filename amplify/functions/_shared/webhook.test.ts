import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import {
  WEBHOOK_TOLERANCE_SECONDS,
  parseSignatureHeader,
  signWebhookBody,
  verifyWebhookSignature,
  webhookEventId,
} from './webhook'

const SECRET = 'whsec_mycarrierpackets_dev'
const NOW = '2026-10-29T12:00:00.000Z'
const TS = Math.floor(Date.parse(NOW) / 1000)
const BODY = JSON.stringify({ id: 'evt_7781', type: 'carrier.updated', carrierMc: 'MC-9981' })

const at = (secondsFromNow: number) => new Date(Date.parse(NOW) + secondsFromNow * 1000).toISOString()

describe('parseSignatureHeader', () => {
  it('reads t and v1 in either order and refuses anything else', () => {
    expect(parseSignatureHeader('t=1761,v1=abcd')).toEqual({ timestamp: 1761, v1: 'abcd' })
    expect(parseSignatureHeader(' v1=abcd , t=1761 ')).toEqual({ timestamp: 1761, v1: 'abcd' })
    expect(parseSignatureHeader('t=1761')).toBeNull()
    expect(parseSignatureHeader('v1=abcd')).toBeNull()
    expect(parseSignatureHeader('abcd')).toBeNull()
    expect(parseSignatureHeader('t=later,v1=abcd')).toBeNull()
    expect(parseSignatureHeader('')).toBeNull()
    expect(parseSignatureHeader(null)).toBeNull()
  })
})

describe('verifyWebhookSignature', () => {
  it('accepts a delivery signed with our secret, in hex or base64', () => {
    const hex = signWebhookBody(BODY, SECRET, TS)
    expect(verifyWebhookSignature({ header: hex, rawBody: BODY, secret: SECRET, nowIso: NOW })).toEqual({ ok: true, timestamp: TS })

    const b64 = createHmac('sha256', SECRET).update(`${TS}.${BODY}`, 'utf8').digest('base64')
    expect(verifyWebhookSignature({ header: `t=${TS},v1=${b64}`, rawBody: BODY, secret: SECRET, nowIso: NOW }).ok).toBe(true)
  })

  it('refuses a tampered body — the signature is over the bytes, not the shape', () => {
    const header = signWebhookBody(BODY, SECRET, TS)
    const tampered = BODY.replace('MC-9981', 'MC-0001')
    expect(verifyWebhookSignature({ header, rawBody: tampered, secret: SECRET, nowIso: NOW })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('refuses another secret, and a delivery we hold no secret for', () => {
    const header = signWebhookBody(BODY, 'somebody-elses-secret', TS)
    expect(verifyWebhookSignature({ header, rawBody: BODY, secret: SECRET, nowIso: NOW })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
    expect(verifyWebhookSignature({ header, rawBody: BODY, secret: '', nowIso: NOW })).toEqual({ ok: false, reason: 'NO_SECRET' })
  })

  it('refuses a timestamp outside the window, in either direction', () => {
    const stale = TS - WEBHOOK_TOLERANCE_SECONDS - 1
    const future = TS + WEBHOOK_TOLERANCE_SECONDS + 1
    expect(verifyWebhookSignature({ header: signWebhookBody(BODY, SECRET, stale), rawBody: BODY, secret: SECRET, nowIso: NOW }))
      .toEqual({ ok: false, reason: 'STALE' })
    expect(verifyWebhookSignature({ header: signWebhookBody(BODY, SECRET, future), rawBody: BODY, secret: SECRET, nowIso: NOW }))
      .toEqual({ ok: false, reason: 'STALE' })
    // A retry a minute late is still the same delivery and is still accepted.
    expect(verifyWebhookSignature({ header: signWebhookBody(BODY, SECRET, TS), rawBody: BODY, secret: SECRET, nowIso: at(60) }).ok).toBe(true)
  })

  it('refuses a replay that re-stamps the clock on a captured body', () => {
    // The timestamp is inside the MAC, so moving it invalidates the old signature.
    const captured = parseSignatureHeader(signWebhookBody(BODY, SECRET, TS - 3600))
    const replayed = `t=${TS},v1=${captured?.v1 ?? ''}`
    expect(verifyWebhookSignature({ header: replayed, rawBody: BODY, secret: SECRET, nowIso: NOW })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('refuses a malformed header and an undecodable digest', () => {
    expect(verifyWebhookSignature({ header: 'nonsense', rawBody: BODY, secret: SECRET, nowIso: NOW })).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(verifyWebhookSignature({ header: `t=${TS},v1=!!!!`, rawBody: BODY, secret: SECRET, nowIso: NOW })).toEqual({ ok: false, reason: 'MALFORMED' })
  })
})

describe('webhookEventId', () => {
  it('uses the provider event id when the body carries one', () => {
    expect(webhookEventId(BODY)).toBe('evt_7781')
    expect(webhookEventId(JSON.stringify({ eventId: 'abc-1' }))).toBe('abc-1')
    expect(webhookEventId(JSON.stringify({ id: 42 }))).toBe('42')
  })

  it('falls back to the body hash, so an identical re-post is the same event', () => {
    const body = JSON.stringify({ type: 'status', at: '2026-10-29T11:59:00.000Z' })
    const hash = createHash('sha256').update(body, 'utf8').digest('hex')
    expect(webhookEventId(body)).toBe(hash)
    expect(webhookEventId(body)).toBe(webhookEventId(body))
    expect(webhookEventId(`${body} `)).not.toBe(hash)
    expect(webhookEventId('not json at all')).toMatch(/^[0-9a-f]{64}$/)
  })
})
