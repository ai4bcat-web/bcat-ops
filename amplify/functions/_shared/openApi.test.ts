import { describe, it, expect } from 'vitest'
import {
  API_SCOPES,
  TOKEN_TTL_SECONDS,
  clientSecretMatches,
  mintClient,
  shipmentApiView,
  tokenFor,
  verifyToken,
  type ApiStopInput,
} from './openApi'

const KEY = 'signing-key-for-the-public-api'
const NOW = '2026-10-29T12:00:00.000Z'

const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

describe('mintClient', () => {
  it('returns a secret once, stores only its hash, and never repeats itself', () => {
    const a = mintClient('Acme TMS', ['READ'])
    const b = mintClient('Acme TMS', ['read'])
    expect(a.clientId).not.toBe(b.clientId)
    expect(a.secret).not.toBe(b.secret)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hash).not.toContain(a.secret)
    expect(clientSecretMatches(a.secret, a.hash)).toBe(true)
  })

  it('refuses a nameless client and an unknown scope', () => {
    expect(() => mintClient('  ', ['READ'])).toThrow(/name/)
    expect(() => mintClient('Acme', [])).toThrow(/scope/)
    expect(() => mintClient('Acme', ['WRITE'])).toThrow(/Unknown scope/)
    expect(API_SCOPES).toEqual(['READ'])
  })
})

describe('clientSecretMatches', () => {
  it('is true for the right secret and false for everything else', () => {
    const { secret, hash } = mintClient('Acme', ['READ'])
    expect(clientSecretMatches(secret, hash)).toBe(true)
    expect(clientSecretMatches(`${secret}x`, hash)).toBe(false)
    // One digit out, same length: the comparison is over the whole digest.
    expect(clientSecretMatches(secret, `${hash.slice(0, 63)}${hash[63] === '0' ? '1' : '0'}`)).toBe(false)
    // Length-safe: a truncated or empty hash is a refusal, not a throw.
    expect(clientSecretMatches(secret, 'abc')).toBe(false)
    expect(clientSecretMatches('', hash)).toBe(false)
    expect(clientSecretMatches(secret, '')).toBe(false)
  })
})

describe('tokenFor / verifyToken', () => {
  it('round-trips the client and its scopes', () => {
    const token = tokenFor('cl-1', ['READ'], KEY, NOW)
    const check = verifyToken(token, KEY, NOW)
    expect(check).toMatchObject({ ok: true, clientId: 'cl-1', scopes: ['READ'] })
  })

  it('expires an hour out, to the second', () => {
    const token = tokenFor('cl-1', ['READ'], KEY, NOW)
    const justInside = new Date(Date.parse(NOW) + (TOKEN_TTL_SECONDS - 1) * 1000).toISOString()
    const past = new Date(Date.parse(NOW) + (TOKEN_TTL_SECONDS + 1) * 1000).toISOString()
    expect(verifyToken(token, KEY, justInside).ok).toBe(true)
    expect(verifyToken(token, KEY, past)).toEqual({ ok: false, reason: 'EXPIRED' })
  })

  it('refuses another key, a malformed token and no key at all', () => {
    const token = tokenFor('cl-1', ['READ'], KEY, NOW)
    expect(verifyToken(token, 'other-key', NOW)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
    expect(verifyToken('not-a-token', KEY, NOW)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(verifyToken('', KEY, NOW)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(verifyToken(token, '', NOW)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' })
  })

  it('refuses a scope smuggled into the payload, because the scope is signed', () => {
    const token = tokenFor('cl-1', ['READ'], KEY, NOW)
    const [payload, signature] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(claims.scopes).toEqual(['READ'])

    const tampered = `${b64url(JSON.stringify({ ...claims, scopes: ['READ', 'WRITE'] }))}.${signature}`
    expect(verifyToken(tampered, KEY, NOW)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })

    // And so is the expiry: pushing `exp` out does not buy another hour.
    const stretched = `${b64url(JSON.stringify({ ...claims, exp: Number(claims.exp) + 86_400 }))}.${signature}`
    expect(verifyToken(stretched, KEY, NOW)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })
})

const SHIPMENT = { number: 'S-1001', status: 'IN_TRANSIT', mode: 'TL' }
const LOADS = [{ id: 'ld-2', leg: 2 }, { id: 'ld-1', leg: 1 }]
const STOPS: ApiStopInput[] = [
  {
    loadId: 'ld-2',
    type: 'delivery',
    sequence: 1,
    name: 'Consignee',
    address: { city: 'Dallas', state: 'TX' },
    appt: '2026-10-22T09:00:00.000Z',
  },
  {
    loadId: 'ld-1',
    type: 'pickup',
    sequence: 1,
    name: 'Shipper',
    address: { city: 'Joliet', state: 'IL' },
    appt: '2026-10-20T14:00:00.000Z',
    apptEnd: '2026-10-20T16:00:00.000Z',
    arrivedAt: '2026-10-20T13:50:00.000Z',
    departedAt: '2026-10-20T15:10:00.000Z',
  },
]

describe('shipmentApiView', () => {
  it('orders the route by leg then stop, and publishes the appointments it found', () => {
    const view = shipmentApiView(SHIPMENT, LOADS, STOPS, { nowIso: NOW })
    expect(view.stops.map((s) => s.city)).toEqual(['Joliet', 'Dallas'])
    expect(view.stops[0]).toEqual({
      type: 'pickup',
      sequence: 1,
      name: 'Shipper',
      city: 'Joliet',
      state: 'IL',
      appt: '2026-10-20T14:00:00.000Z',
      apptEnd: '2026-10-20T16:00:00.000Z',
      arrivedAt: '2026-10-20T13:50:00.000Z',
      departedAt: '2026-10-20T15:10:00.000Z',
    })
    expect(view.appointments).toEqual([
      { sequence: 1, type: 'pickup', at: '2026-10-20T14:00:00.000Z', end: '2026-10-20T16:00:00.000Z' },
      { sequence: 1, type: 'delivery', at: '2026-10-22T09:00:00.000Z', end: null },
    ])
    expect(view.generatedAt).toBe(NOW)
  })

  it('says VOIDED for a voided shipment rather than hiding it', () => {
    const view = shipmentApiView({ ...SHIPMENT, voidedAt: '2026-10-25T00:00:00.000Z' }, LOADS, STOPS, { nowIso: NOW })
    expect(view.status).toBe('VOIDED')
    expect(view.number).toBe('S-1001')
    expect(view.stops.length).toBe(2)
  })

  it('publishes only the references the desk made customer-visible', () => {
    const view = shipmentApiView(SHIPMENT, LOADS, STOPS, {
      nowIso: NOW,
      references: [
        { code: 'PO', value: '99-12', visibility: 'CUSTOMER' },
        { code: 'BOL', label: 'Bill of lading', value: 'B-7', visibility: 'ALL' },
        { code: 'MARGIN_NOTE', value: 'sold at 18%', visibility: 'INTERNAL' },
      ],
    })
    expect(view.references).toEqual([
      { code: 'PO', label: null, value: '99-12' },
      { code: 'BOL', label: 'Bill of lading', value: 'B-7' },
    ])
  })

  it('carries no money and no Order, however rich the rows it was built from', () => {
    const view = shipmentApiView(
      // Everything a real row drags along: rates, margin, the Order id, the carrier.
      { ...SHIPMENT, ...({ rateCents: 240_000, marginCents: 38_000, orderIds: ['ord-1'] } as object) },
      [{ id: 'ld-1', leg: 1, ...({ carrierPayCents: 190_000, carrierName: 'Blue Sky', driverPhone: '+1555' } as object) }],
      [{ ...STOPS[1], ...({ accessorialCents: 5000, order: { id: 'ord-1' } } as object) }],
      { nowIso: NOW, references: [{ code: 'PO', value: '99-12', visibility: 'CUSTOMER' }] },
    )

    const keys: string[] = []
    const walk = (value: unknown) => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return }
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.push(key)
        walk(child)
      }
    }
    walk(view)

    expect(keys.length).toBeGreaterThan(10)
    expect(keys.filter((k) => k.endsWith('Cents'))).toEqual([])
    expect(keys.filter((k) => k === 'order' || k === 'orderIds')).toEqual([])
    expect(JSON.stringify(view)).not.toContain('Blue Sky')
    expect(JSON.stringify(view)).not.toContain('+1555')
  })
})
