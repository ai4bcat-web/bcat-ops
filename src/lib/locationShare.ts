/**
 * Step AO — what a driver's "share my location" text says, read without any network.
 *
 * Three shapes arrive by SMS: an Apple Maps link (`maps.apple.com/?ll=…`), a Google Maps
 * link (long, or a `maps.app.goo.gl` short link that only a redirect can resolve) and bare
 * coordinates. A bare number pair is a false-positive minefield (phone numbers, PRO
 * numbers, dates), so it needs three decimals on both halves and a point inside the US,
 * Alaska, Hawaii or Puerto Rico. An explicit map link is the driver's own act and is
 * accepted at any precision, inside the same box.
 */

export type ShareParse =
  | { kind: 'COORDS' | 'APPLE_MAPS' | 'GOOGLE_MAPS'; lat: number; lng: number; label: string | null }
  | { kind: 'SHORT_LINK'; url: string }            // maps.app.goo.gl / goo.gl/maps — needs a server-side redirect resolve

const LAT_MIN = 17
const LAT_MAX = 72
const LNG_MIN = -180
const LNG_MAX = -64

function plausible(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= LAT_MIN && lat <= LAT_MAX && lng >= LNG_MIN && lng <= LNG_MAX
}

const PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

function pairOf(text: string | null | undefined): { lat: number; lng: number } | null {
  if (!text) return null
  const m = PAIR.exec(text)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  return plausible(lat, lng) ? { lat, lng } : null
}

const APPLE_HOSTS = ['maps.apple.com', 'maps.apple']
const GOOGLE_HOSTS = ['www.google.com', 'google.com', 'maps.google.com', 'www.google.co.uk']
const SHORT_HOSTS = ['maps.app.goo.gl', 'goo.gl']
const ALLOWED_SHARE_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'www.google.com', 'maps.google.com', 'maps.apple.com']

function parseUrl(raw: string): URL | null {
  try { return new URL(raw) } catch { return null }
}

function fromAppleUrl(u: URL): ShareParse | null {
  const p = u.searchParams
  for (const key of ['ll', 'sll', 'q', 'coordinate', 'daddr']) {
    const hit = pairOf(p.get(key))
    if (hit) {
      const label = p.get('address') ?? p.get('name') ?? (pairOf(p.get('q')) ? null : p.get('q'))
      return { kind: 'APPLE_MAPS', ...hit, label: label || null }
    }
  }
  return null
}

function fromGoogleUrl(u: URL): ShareParse | null {
  const p = u.searchParams
  for (const key of ['q', 'll', 'query', 'center', 'daddr']) {
    const hit = pairOf(p.get(key))
    if (hit) return { kind: 'GOOGLE_MAPS', ...hit, label: null }
  }
  const path = decodeURIComponent(u.pathname + u.hash)
  // The pin itself (`!3d…!4d…`) beats the viewport centre (`/@…`).
  const data = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(path + u.search)
  const view = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path)
  const m = data ?? view
  if (m) {
    const lat = Number(m[1])
    const lng = Number(m[2])
    if (plausible(lat, lng)) {
      const place = /\/place\/([^/@]+)/.exec(path)
      return { kind: 'GOOGLE_MAPS', lat, lng, label: place ? place[1].replace(/\+/g, ' ') : null }
    }
  }
  return null
}

// A raw pair needs three decimals each; the look-behind keeps "12345.678" from yielding "345.678".
const RAW_PAIR = /(?<![\d.-])(-?\d{1,3}\.\d{3,})\s*[,;]?\s*(-?\d{1,3}\.\d{3,})(?![\d.])/
const LABELLED_PAIR = /\blat(?:itude)?\s*[:=]?\s*(-?\d{1,3}\.\d{3,})\D{1,12}?\bl(?:on(?:g|gitude)?|ng)\s*[:=]?\s*(-?\d{1,3}\.\d{3,})/i

export function parseLocationShare(text: string): ShareParse | null {
  if (!text) return null
  const urls = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? []
  for (const raw of urls) {
    const u = parseUrl(raw.replace(/[.,;]+$/, ''))
    if (!u) continue
    const host = u.hostname.toLowerCase()
    if (APPLE_HOSTS.includes(host)) {
      const hit = fromAppleUrl(u)
      if (hit) return hit
    } else if (GOOGLE_HOSTS.includes(host) || /^maps\.google\.[a-z.]+$/.test(host)) {
      const hit = fromGoogleUrl(u)
      if (hit) return hit
    } else if (SHORT_HOSTS.includes(host)) {
      if (host === 'goo.gl' && !u.pathname.startsWith('/maps')) continue
      return { kind: 'SHORT_LINK', url: u.toString() }
    }
  }
  const labelled = LABELLED_PAIR.exec(text) ?? RAW_PAIR.exec(text)
  if (labelled) {
    const lat = Number(labelled[1])
    const lng = Number(labelled[2])
    if (plausible(lat, lng)) return { kind: 'COORDS', lat, lng, label: null }
  }
  return null
}

const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'
// "OK", "OR", "ME" and "HI" are also words; without a comma or a preposition they are chatter.
const SAFE_STATES = STATES.split('|').filter((s) => !['OK', 'OR', 'ME', 'HI', 'IN'].includes(s)).join('|')
const CITY_STATE_COMMA = new RegExp(`\\b[A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+)*\\s*,\\s*(?:${STATES})\\b`)
const CITY_STATE = new RegExp(`\\b[A-Z][A-Za-z.'-]+\\s+(?:${SAFE_STATES})\\b`)

/** The gate in front of the geocoder: cuts "Thanks" and "ok" before they cost a Geocoding call. */
export function looksLikePlace(text: string): boolean {
  const t = text.trim()
  if (t.length < 4) return false
  if (CITY_STATE_COMMA.test(t) || CITY_STATE.test(t)) return true
  // The preposition is matched case-insensitively; the place after it must be capitalised
  // ("in Dallas tx" passes, "near gary indiana" does not).
  const m = /\b(?:in|near|at|past|passed|by|leaving|outside|approaching)\s+(?:the\s+)?([A-Za-z][A-Za-z.'-]*)/gi
  for (let hit = m.exec(t); hit; hit = m.exec(t)) {
    if (/^[A-Z]/.test(hit[1])) return true
  }
  return false
}

/** The SSRF allow-list: https only, exact hosts, no credentials, no port. */
export function isAllowedShareHost(url: string): boolean {
  const u = parseUrl(url)
  if (!u) return false
  return u.protocol === 'https:' && !u.username && !u.password && u.port === '' && ALLOWED_SHARE_HOSTS.includes(u.hostname.toLowerCase())
}

/** The URL / GEO line of a shared-location vCard; null when it carries neither. */
export function textOfVcard(vcf: string): string | null {
  const lines = vcf.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const unescape = (v: string): string => v.replace(/\\([,;:\\])/g, '$1').trim()
  const urls: string[] = []
  let geo: string | null = null
  for (const line of lines) {
    const m = /^(?:[\w-]+\.)?(URL|GEO)[^:]*:(.*)$/i.exec(line)
    if (!m) continue
    const value = unescape(m[2])
    if (m[1].toUpperCase() === 'GEO') {
      const g = /^(-?\d+(?:\.\d+)?)[;,]\s*(-?\d+(?:\.\d+)?)$/.exec(value.replace(/^geo:/i, ''))
      if (g && plausible(Number(g[1]), Number(g[2]))) geo = `${g[1]}, ${g[2]}`
    } else if (/^https?:\/\//i.test(value)) {
      urls.push(value)
    }
  }
  const mapUrl = urls.find((x) => {
    const u = parseUrl(x)
    return !!u && [...APPLE_HOSTS, ...GOOGLE_HOSTS, ...SHORT_HOSTS].includes(u.hostname.toLowerCase())
  })
  return mapUrl ?? geo ?? null
}
