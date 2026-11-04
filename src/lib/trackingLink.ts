/**
 * The two public tracking pages, and the rule about what each of them may say.
 *
 * A customer link and a carrier ping link are both an unguessable token in a URL with
 * no sign-in behind it, so the safe thing is not to filter a rich record on the way
 * out — it is to build a small one. `customerView` and `carrierView` assemble exactly
 * the fields their page prints: the customer never learns who is hauling (unless the
 * link was minted saying so), what anybody is paid, or what an internal reference
 * says; the carrier never learns whose freight it is or what the load sold for.
 *
 * Coordinates on the customer page are rounded to three decimals — roughly a hundred
 * metres, enough for "somewhere in Joliet" and not enough to follow a driver home.
 *
 * Imports are relative: the public tracking Lambda bundles this file by path, so a
 * `@/` alias would break the function build.
 */
import type { Stop } from '../types'
import type {
  CarrierTrackingView,
  CustomerTrackingView,
  Division,
  LoadCarrierRecord,
  LoadCheckCallRecord,
  OrderRecord,
  ReferenceVisibility,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
  TrackingLinkKind,
  TrackingLinkRecord,
  TrackingViewContact,
  TrackingViewPing,
  TrackingViewReference,
  TrackingViewStop,
} from '../types/tms'
import { currentFix, thinFixes, type TrackingFix } from './trackingPings'
import type { LastKnownFix } from './trackingTimeline'
import { MAX_SMS_BODY } from './dispatch'

export type { CarrierTrackingView, CustomerTrackingView } from '../types/tms'

/** 24 random bytes, base64url: 32 characters, no padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/

export function isLinkToken(value: string | null | undefined): boolean {
  return TOKEN_RE.test(value ?? '')
}

/** The secret behind every public link: 24 random bytes, base64url, 32 characters. */
export const TOKEN_BYTES = 24

const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Mint one link token. The randomness is an argument rather than a global so this
 * file stays pure — the Lambda hands it `randomBytes` from `node:crypto`, a test
 * hands it a counter, and both get something `isLinkToken` accepts.
 *
 * 24 bytes divide into exactly eight base64 groups, so the encoding never pads and
 * the token never carries an `=` that a URL would have to escape.
 */
export function newLinkToken(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES)
  if (bytes.length !== TOKEN_BYTES) {
    throw new Error(`A link token needs ${TOKEN_BYTES} random bytes`)
  }
  let token = ''
  for (let at = 0; at < TOKEN_BYTES; at += 3) {
    const word = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2]
    token +=
      BASE64URL[(word >> 18) & 63] +
      BASE64URL[(word >> 12) & 63] +
      BASE64URL[(word >> 6) & 63] +
      BASE64URL[word & 63]
  }
  return token
}

/** How long a carrier ping link lives past the last delivery appointment. */
export const DEFAULT_TRACKING_LINK_EXPIRY_HOURS = 72
/** How long a customer tracking link lives. */
export const DEFAULT_CUSTOMER_LINK_EXPIRY_DAYS = 14
/** No link is ever minted with less than a day on it, however late the freight is. */
const MINIMUM_LINK_HOURS = 24
/** The text the carrier gets, when the org has not written its own. */
export const DEFAULT_TRACKING_SMS_TEMPLATE =
  '{broker}: share your location for load {loadNumber} here: {url}'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const BROKER_FALLBACK = 'BCAT Logistics'

export type TrackingLinkSettings = Pick<
  TmsSettings,
  'trackingLinkExpiryHours' | 'customerLinkExpiryDays'
>

/**
 * When a link stops working.
 *
 * A ping link is tied to the freight: the last delivery appointment plus the
 * configured hours, because a driver who runs a day late still has to be able to tap
 * it. A customer link is tied to the calendar. Either way it gets at least a day,
 * which is what keeps a link minted for an already-delivered load usable.
 */
export function linkExpiry(
  kind: TrackingLinkKind,
  lastDeliveryAppt: string | null | undefined,
  settings: TrackingLinkSettings | null | undefined,
  nowIso: string,
): string {
  const now = Date.parse(nowIso)
  if (Number.isNaN(now)) throw new Error('linkExpiry needs a valid timestamp')

  let expires: number
  if (kind === 'CARRIER_PING' || kind === 'PROVIDER_TRACK') {
    const hours = settings?.trackingLinkExpiryHours
    const appt = Date.parse(lastDeliveryAppt ?? '')
    const base = Number.isNaN(appt) ? now : appt
    expires =
      base +
      (typeof hours === 'number' && Number.isFinite(hours) && hours > 0
        ? hours
        : DEFAULT_TRACKING_LINK_EXPIRY_HOURS) *
        HOUR_MS
  } else {
    const days = settings?.customerLinkExpiryDays
    expires =
      now +
      (typeof days === 'number' && Number.isFinite(days) && days > 0
        ? days
        : DEFAULT_CUSTOMER_LINK_EXPIRY_DAYS) *
        DAY_MS
  }
  return new Date(Math.max(expires, now + MINIMUM_LINK_HOURS * HOUR_MS)).toISOString()
}

/** Enum to prose: IN_TRANSIT reads "In transit" on a page a customer sees. */
const humanStatus = (status: string): string => {
  const words = status.replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function viewReferences(
  refs: { code: string; label?: string | null; value: string; visibility: ReferenceVisibility }[]
    | null
    | undefined,
  audience: 'CUSTOMER' | 'CARRIER',
): TrackingViewReference[] {
  return (refs ?? [])
    .filter((ref) => ref.visibility === audience || ref.visibility === 'ALL')
    .map((ref) => ({ code: ref.code, label: ref.label ?? null, value: ref.value }))
}

function viewStop(stop: Stop, audience: 'CUSTOMER' | 'CARRIER'): TrackingViewStop {
  const parts = (stop.city ?? '').split(',')
  return {
    id: stop.id,
    type: stop.type,
    sequence: stop.sequence ?? 0,
    name: stop.name?.trim() || null,
    city: stop.address?.city?.trim() || parts[0]?.trim() || null,
    state: stop.address?.state?.trim() || parts[1]?.trim() || null,
    appt: stop.appt ?? null,
    apptEnd: stop.apptEnd ?? null,
    arrivedAt: stop.arrivedAt ?? null,
    departedAt: stop.departedAt ?? null,
    references: viewReferences(stop.refs, audience),
  }
}

/** Every leg's stops on one route, in the order the freight meets them. */
function routeStops(loads: ShipmentLoad[], audience: 'CUSTOMER' | 'CARRIER'): TrackingViewStop[] {
  const ordered = [...loads].sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  const stops: TrackingViewStop[] = []
  for (const load of ordered) {
    const legStops = [...(load.stops ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    for (const stop of legStops) stops.push(viewStop(stop, audience))
  }
  return stops
}

function latestEvent(events: LoadCheckCallRecord[] | null | undefined): LoadCheckCallRecord | null {
  let latest: LoadCheckCallRecord | null = null
  let latestAt = Number.NEGATIVE_INFINITY
  for (const event of events ?? []) {
    const at = Date.parse(event.at)
    if (Number.isNaN(at) || at <= latestAt) continue
    latest = event
    latestAt = at
  }
  return latest
}

function viewContact(link: TrackingLinkRecord): TrackingViewContact | null {
  const name = link.contactName?.trim() || null
  const email = link.contactEmail?.trim() || null
  const phone = link.contactPhone?.trim() || null
  return name == null && email == null && phone == null ? null : { name, email, phone }
}

export interface CustomerViewInput {
  shipment: ShipmentRecord
  orders: OrderRecord[]
  loads: ShipmentLoad[]
  loadCarriers?: LoadCarrierRecord[] | null
  events?: LoadCheckCallRecord[] | null
  /** The newest fix from `lastKnownPosition`, already merged across sources. */
  position?: LastKnownFix | null
  /** Step AO: every fix of the tracking window, all sources. Absent = no map. */
  fixes?: TrackingFix[] | null
  /** Step AO: the cached route's encoded polyline for `routeLoadOf(...)`, when one exists. */
  route?: string | null
  link: TrackingLinkRecord
  division?: Division | null
  nowIso: string
}

const TRAIL_GAP_MIN = 15
const TRAIL_MAX = 96
/** A staff-logged position newer than the newest ping by more than this has no ping of its own. */
const OWN_PING_SLACK_MS = 2 * 60_000

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** The stops that carry coordinates, as a route's waypoints: first pickup, middle stops (≤ 8), last delivery. Full precision. */
export function routeWaypoints(stops: Stop[] | null | undefined): Array<{ type: 'pickup' | 'delivery' | 'stop'; lat: number; lng: number }> {
  const located = [...(stops ?? [])]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .filter((s) => typeof s.address?.lat === 'number' && typeof s.address?.lng === 'number' &&
      Number.isFinite(s.address.lat) && Number.isFinite(s.address.lng))
  if (located.length === 0) return []
  const pt = (s: Stop, type: 'pickup' | 'delivery' | 'stop') => ({ type, lat: s.address!.lat as number, lng: s.address!.lng as number })
  if (located.length === 1) return [pt(located[0], located[0].type)]
  const middle = located.slice(1, -1).slice(0, 8).map((s) => pt(s, 'stop'))
  return [pt(located[0], 'pickup'), ...middle, pt(located[located.length - 1], 'delivery')]
}

/** The leg the customer's map and route describe: the active assignment's load, else the first leg. */
export function routeLoadOf(loads: ShipmentLoad[], loadCarriers: LoadCarrierRecord[] | null | undefined): ShipmentLoad | null {
  const ordered = [...loads].sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  const active = (loadCarriers ?? []).find((lc) => lc.status === 'ACTIVE')
  return ordered.find((l) => l.id === active?.loadId) ?? ordered[0] ?? null
}

/**
 * What the Customer Link shows.
 *
 * The carrier appears only when the link itself was minted with `showCarrier`, and
 * then by name alone — never the driver, never a phone number. The position is
 * dropped entirely, not nulled, when the link hides it. The map (stops, route, trail)
 * follows the same rule and carries no source, accuracy, speed or reference.
 */
export function customerView(input: CustomerViewInput): CustomerTrackingView {
  const { link, shipment } = input
  const stops = routeStops(input.loads, 'CUSTOMER')
  const references: TrackingViewReference[] = []
  for (const order of input.orders) references.push(...viewReferences(order.references, 'CUSTOMER'))

  const lastDelivery = [...stops].reverse().find((s) => s.type === 'delivery') ?? null
  const active = (input.loadCarriers ?? []).find((lc) => lc.status === 'ACTIVE') ?? null
  const eta =
    lastDelivery != null && lastDelivery.departedAt == null
      ? active?.deliveryEtaAt ?? null
      : null

  const view: CustomerTrackingView = {
    broker: { name: input.division?.name?.trim() || BROKER_FALLBACK },
    number: shipment.number,
    status: shipment.status,
    statusLabel: humanStatus(shipment.status),
    stops,
    references,
    eta,
    lastUpdate: null,
    contact: viewContact(link),
    generatedAt: input.nowIso,
  }

  const latest = latestEvent(input.events)
  if (latest != null) view.lastUpdate = { at: latest.at, type: latest.type }

  if (link.showPosition !== false) {
    // Every source is on `fixes`; the timeline's own newest fix only wins when a person
    // logged a position that has no ping of its own (a staff check call with coordinates).
    const cur = input.fixes?.length ? currentFix(input.fixes, Date.parse(input.nowIso)) : null
    const staff = input.position
    const staffNewer =
      staff != null && (cur == null || Date.parse(staff.at) - Date.parse(cur.fix.at) > OWN_PING_SLACK_MS)
    if (staffNewer && staff) {
      view.position = { lat: round3(staff.lat), lng: round3(staff.lng), at: staff.at, description: staff.description }
    } else if (cur) {
      view.position = {
        lat: round3(cur.fix.lat),
        lng: round3(cur.fix.lng),
        at: cur.fix.at,
        description: cur.fix.place,
        ...(cur.fix.approx ? { approx: true as const } : {}),
      }
    }

    if (input.fixes != null) {
      const leg = routeLoadOf(input.loads, input.loadCarriers)
      view.map = {
        stops: routeWaypoints(leg?.stops).map((w) => ({ type: w.type, lat: round3(w.lat), lng: round3(w.lng) })),
        route: input.route ?? null,
        trail: thinFixes(input.fixes, TRAIL_GAP_MIN, TRAIL_MAX).map((f) => ({
          lat: round3(f.lat),
          lng: round3(f.lng),
          at: f.at,
          ...(f.approx ? { approx: true as const } : {}),
        })),
      }
    }
  }

  const carrierName = active?.carrierName?.trim()
  if (link.showCarrier === true && carrierName) view.carrier = { name: carrierName }

  return view
}

export interface CarrierViewInput {
  load: ShipmentLoad
  /** The driver's own pings and nothing else; `link.id` is what makes them "own". */
  events?: LoadCheckCallRecord[] | null
  link: TrackingLinkRecord
  /** The desk the driver should call. Falls back to the contact snapshot on the link. */
  contactPhone?: string | null
  /** The brokerage's name for the consent text. */
  broker?: string | null
  nowIso: string
}

/** How often the driver's page posts a fix while it is open. A server value, so it can change without shipping the page. */
export const SHARE_EVERY_MIN = 5
/** Bump when the consent wording changes; recorded with the consent. */
export const CONSENT_VERSION = 'ao-1'
/** The statuses at which a load is done as far as sharing goes. */
const CLOSED_STATUSES: Record<string, true> = { DELIVERED: true, INVOICING: true, CANCELED: true }

/** A closed load stops accepting a driver's location: delivered, invoicing, canceled, or a delivery time on file. */
export function loadIsClosed(load: { status?: string | null; deliveredAt?: string | null }): boolean {
  return Boolean(load.deliveredAt) || CLOSED_STATUSES[load.status ?? ''] === true
}

/** The wording the driver agrees to. Rendered verbatim by the page; versioned by `CONSENT_VERSION`. */
export function consentText(broker: string, loadNumber: string): string {
  return (
    `${broker} will receive this phone's location while this page is open — about every ${SHARE_EVERY_MIN} minutes — ` +
    `until load ${loadNumber} is delivered or you tap Stop sharing. It is used only to track this load. ` +
    `It is shown to ${broker} dispatch and, as a map position, to the customer whose freight you are hauling. ` +
    'We keep it for 90 days. You can stop at any time; nothing is collected when the page is closed.'
  )
}

/**
 * What the driver's ping page shows: which load, where it goes next, and proof that
 * the taps landed. Whose freight it is and what it sold for are none of its business.
 */
export function carrierView(input: CarrierViewInput): CarrierTrackingView {
  const { link, load } = input
  const stops = routeStops([load], 'CARRIER')
  const nextStop = stops.find((s) => s.departedAt == null) ?? null

  const own = `link:${link.id.slice(0, 8)}`
  const pings: TrackingViewPing[] = (input.events ?? [])
    .filter((event) => event.type === 'TRACKING_PING' && event.createdBy === own)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((event) => ({
      at: event.at,
      lat: event.lat ?? null,
      lng: event.lng ?? null,
      accuracyM: event.accuracyM ?? null,
    }))

  const status = load.status ?? 'SOURCING'
  const loadNumber = load.loadNumber ?? ''
  return {
    loadNumber,
    status,
    statusLabel: humanStatus(status),
    stops,
    nextStop,
    pings,
    share: {
      everyMin: SHARE_EVERY_MIN,
      consentRequired: !link.consentAt,
      consentVersion: CONSENT_VERSION,
      consentText: consentText(input.broker?.trim() || BROKER_FALLBACK, loadNumber),
      active: !loadIsClosed(load),
      lastPingAt: link.lastPingAt ?? null,
      pingCount: link.pingCount ?? 0,
    },
    contactPhone: input.contactPhone?.trim() || link.contactPhone?.trim() || null,
    generatedAt: input.nowIso,
  }
}

export interface SmsVariables {
  broker: string
  loadNumber: string
  url: string
}

/**
 * The carrier text, filled in and kept inside one Twilio body.
 *
 * The link is the only part that has to survive, so an over-long template loses its
 * prose and keeps the URL rather than being truncated mid-token.
 */
export function smsBodyFor(template: string | null | undefined, vars: SmsVariables): string {
  // split/join rather than `replaceAll` (ES2021) or `replace`: the Lambda tsconfig is
  // ES2020, and a value containing `$&` must land verbatim, not as a replacement pattern.
  const body = (template?.trim() || DEFAULT_TRACKING_SMS_TEMPLATE)
    .split('{broker}')
    .join(vars.broker)
    .split('{loadNumber}')
    .join(vars.loadNumber)
    .split('{url}')
    .join(vars.url)
  if (body.length <= MAX_SMS_BODY) return body

  const start = body.lastIndexOf(vars.url)
  if (start < 0) return body.slice(0, MAX_SMS_BODY)
  const tail = body.slice(start)
  if (tail.length >= MAX_SMS_BODY) return tail.slice(0, MAX_SMS_BODY)
  return `${body.slice(0, MAX_SMS_BODY - tail.length - 2).trimEnd()}… ${tail}`
}
