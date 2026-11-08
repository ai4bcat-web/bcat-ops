/**
 * BCAT's own public API: how a client is minted, how its token is signed and read
 * back, and exactly what a shipment looks like to somebody outside the building.
 *
 * Three rules shape this file.
 *
 * 1. A client secret exists once. `mintClient` returns it, the caller shows it to
 *    the admin, and only its SHA-256 is ever written down — so a leaked parameter
 *    store is not a leaked credential.
 * 2. A token carries its own claims. The scopes are inside the signed payload, not
 *    looked up beside it, so a tampered scope fails the signature rather than being
 *    believed. The signing shape is the one `tms-geocode` already mints and
 *    `tms-directory-actions` already verifies: `<payloadB64url>.<sigB64url>`, the
 *    HMAC taken over the payload JSON itself.
 * 3. The public shipment view is built, never filtered. `shipmentApiView` assembles
 *    a small record field by field — the way `customerView` in `trackingLink.ts`
 *    does — so no rate, no margin, no carrier pay and no internal id can reach an
 *    API consumer by being added to a model later. A voided shipment answers with
 *    `status: 'VOIDED'`: a PRO is permanent and a customer's system must not be
 *    told the freight never existed.
 *
 * Imports are relative and `node:crypto` only: the public tracking Lambda bundles
 * this file by path, so a `@/` alias would break the function build.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** How long an issued access token is good for. One hour, as `expires_in` says. */
export const TOKEN_TTL_SECONDS = 3600

/** The scopes a client may be issued. READ is the only one the API answers today. */
export const API_SCOPES = ['READ'] as const
export type ApiScope = (typeof API_SCOPES)[number]

/** 18 bytes of base64url: 24 characters, no padding, URL-safe. */
const CLIENT_ID_BYTES = 18
/** 32 bytes of base64url: 43 characters. A guessing attack is not the threat model. */
const CLIENT_SECRET_BYTES = 32

export interface MintedClient {
  clientId: string
  /** Returned once. Never stored, never logged, never answered again. */
  secret: string
  /** SHA-256 of `secret`, hex. The only form that is written down. */
  hash: string
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * A new API client. The name and scopes are the caller's to store on the row; the
 * secret is the caller's to show once and forget.
 */
export function mintClient(name: string, scopes: string[]): MintedClient {
  if (!name.trim()) throw new Error('An API client needs a name')
  const wanted = scopes.map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (wanted.length === 0) throw new Error('An API client needs at least one scope')
  for (const scope of wanted) {
    if (!(API_SCOPES as readonly string[]).includes(scope)) throw new Error(`Unknown scope ${scope}`)
  }
  const secret = b64url(randomBytes(CLIENT_SECRET_BYTES))
  return {
    clientId: b64url(randomBytes(CLIENT_ID_BYTES)),
    secret,
    hash: sha256Hex(secret),
  }
}

/** What a token says about itself once the signature has been believed. */
export interface TokenPayload {
  clientId: string
  scopes: string[]
  /** Seconds since the epoch, as a JWT would write them. */
  iat: number
  exp: number
}

/**
 * One access token. The payload is signed as JSON, exactly the bytes a verifier
 * reads back, so there is no canonicalisation to disagree about.
 */
export function tokenFor(clientId: string, scopes: string[], signingKey: string, nowIso: string): string {
  if (!signingKey) throw new Error('The public API signing key is not configured')
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) throw new Error('tokenFor needs a valid timestamp')
  const iat = Math.floor(now / 1000)
  const payload: TokenPayload = { clientId, scopes, iat, exp: iat + TOKEN_TTL_SECONDS }
  const payloadJson = JSON.stringify(payload)
  const signature = createHmac('sha256', signingKey).update(payloadJson, 'utf8').digest()
  return `${b64url(Buffer.from(payloadJson, 'utf8'))}.${b64url(signature)}`
}

export type TokenRefusal = 'NOT_CONFIGURED' | 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED'

export type TokenCheck =
  | { ok: true; clientId: string; scopes: string[]; expiresAt: number }
  | { ok: false; reason: TokenRefusal }

/**
 * Read a token back, or say why not.
 *
 * The signature is compared in constant time over equal-length buffers, and it is
 * compared *before* the payload is trusted for anything — including its own expiry
 * — so a forged `exp` buys nothing.
 */
export function verifyToken(token: string, signingKey: string, nowIso: string): TokenCheck {
  if (!signingKey) return { ok: false, reason: 'NOT_CONFIGURED' }
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'MALFORMED' }
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'MALFORMED' }

  const payloadJson = fromB64url(parts[0]).toString('utf8')
  const computed = createHmac('sha256', signingKey).update(payloadJson, 'utf8').digest()
  const provided = fromB64url(parts[1])
  if (computed.length !== provided.length || !timingSafeEqual(computed, provided)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }

  let payload: Partial<TokenPayload>
  try {
    payload = JSON.parse(payloadJson) as Partial<TokenPayload>
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }
  const clientId = typeof payload.clientId === 'string' ? payload.clientId : ''
  const exp = typeof payload.exp === 'number' ? payload.exp : Number.NaN
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((s): s is string => typeof s === 'string') : []
  if (!clientId || !Number.isFinite(exp)) return { ok: false, reason: 'MALFORMED' }

  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return { ok: false, reason: 'MALFORMED' }
  if (exp * 1000 <= now) return { ok: false, reason: 'EXPIRED' }

  return { ok: true, clientId, scopes, expiresAt: exp }
}

/**
 * Does this secret hash to what we stored? Length-safe, and constant-time over the
 * digests rather than over the strings, so a wrong secret and an unknown client
 * cost the caller the same time as a right one.
 */
export function clientSecretMatches(secret: string, hash: string): boolean {
  if (typeof secret !== 'string' || typeof hash !== 'string' || !secret || !hash) return false
  const expected = Buffer.from(hash.trim().toLowerCase(), 'utf8')
  const actual = Buffer.from(sha256Hex(secret), 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

// ── The public shipment view ────────────────────────────────────────────────

/** Exactly what the view needs of a shipment row, and nothing it could leak. */
export interface ApiShipmentInput {
  number: string
  status: string
  mode?: string | null
  voidedAt?: string | null
}

/** A leg, for the order its stops come in. The leg itself is not published. */
export interface ApiLoadInput {
  id: string
  leg?: number | null
}

/** A stop as the Load row carries it, already parsed out of its JSON column. */
export interface ApiStopInput {
  loadId?: string | null
  type?: string | null
  sequence?: number | null
  name?: string | null
  city?: string | null
  address?: { city?: string | null; state?: string | null } | null
  appt?: string | null
  apptEnd?: string | null
  arrivedAt?: string | null
  departedAt?: string | null
}

/** An order reference, with the visibility the desk gave it. */
export interface ApiReferenceInput {
  code: string
  label?: string | null
  value: string
  visibility?: string | null
}

export interface PublicShipmentStop {
  type: string
  sequence: number
  name: string | null
  city: string | null
  state: string | null
  appt: string | null
  apptEnd: string | null
  arrivedAt: string | null
  departedAt: string | null
}

export interface PublicShipmentAppointment {
  sequence: number
  type: string
  at: string
  end: string | null
}

export interface PublicShipmentReference {
  code: string
  label: string | null
  value: string
}

/**
 * The whole of what the API answers about a shipment. Every field is written here
 * by hand: there is no spread of a record, so nothing a later step adds to
 * `Shipment`, `Load` or `Stop` can appear on this shape without somebody editing
 * this interface and this builder.
 */
export interface PublicShipmentView {
  number: string
  status: string
  mode: string | null
  stops: PublicShipmentStop[]
  appointments: PublicShipmentAppointment[]
  references: PublicShipmentReference[]
  generatedAt: string
}

export interface ShipmentApiViewOptions {
  /** Order references; only CUSTOMER and ALL ever leave the building. */
  references?: ApiReferenceInput[] | null
  nowIso?: string
}

const text = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || null
}

function publicStop(stop: ApiStopInput): PublicShipmentStop {
  // `city` on a legacy stop is the whole "Joliet, IL"; the booked address wins.
  const parts = (stop.city ?? '').split(',')
  return {
    type: text(stop.type) ?? 'stop',
    sequence: Number.isFinite(Number(stop.sequence)) ? Number(stop.sequence) : 0,
    name: text(stop.name),
    city: text(stop.address?.city) ?? text(parts[0]),
    state: text(stop.address?.state) ?? text(parts[1]),
    appt: text(stop.appt),
    apptEnd: text(stop.apptEnd),
    arrivedAt: text(stop.arrivedAt),
    departedAt: text(stop.departedAt),
  }
}

/**
 * The shipment as an outside system reads it.
 *
 * `loads` orders the route — a stop belongs to a leg, and the legs run in order —
 * and is published no further than that: who hauled it, for how much, and under
 * which carrier agreement are not the customer's business. A voided shipment is
 * answered, not hidden, with `status: 'VOIDED'`.
 */
export function shipmentApiView(
  shipment: ApiShipmentInput,
  loads: ApiLoadInput[],
  stops: ApiStopInput[],
  options: ShipmentApiViewOptions = {},
): PublicShipmentView {
  const legOf = new Map<string, number>()
  loads.forEach((load, at) => legOf.set(load.id, Number(load.leg ?? at + 1)))

  const ordered = [...stops].sort((a, b) => {
    const legA = legOf.get(a.loadId ?? '') ?? Number.MAX_SAFE_INTEGER
    const legB = legOf.get(b.loadId ?? '') ?? Number.MAX_SAFE_INTEGER
    if (legA !== legB) return legA - legB
    return Number(a.sequence ?? 0) - Number(b.sequence ?? 0)
  })

  const publicStops = ordered.map(publicStop)
  const appointments: PublicShipmentAppointment[] = publicStops
    .filter((stop): stop is PublicShipmentStop & { appt: string } => stop.appt != null)
    .map((stop) => ({ sequence: stop.sequence, type: stop.type, at: stop.appt, end: stop.apptEnd }))

  const references: PublicShipmentReference[] = (options.references ?? [])
    .filter((ref) => ref.visibility == null || ref.visibility === 'CUSTOMER' || ref.visibility === 'ALL')
    .map((ref) => ({ code: ref.code, label: text(ref.label), value: ref.value }))

  return {
    number: shipment.number,
    status: shipment.voidedAt ? 'VOIDED' : shipment.status,
    mode: text(shipment.mode),
    stops: publicStops,
    appointments,
    references,
    generatedAt: options.nowIso ?? new Date().toISOString(),
  }
}
