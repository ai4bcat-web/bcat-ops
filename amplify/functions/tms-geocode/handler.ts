/**
 * tms-geocode Lambda — AppSync query `tmsGeocode(action, input)`.
 *
 * Actions:
 *   GEOCODE       input: { address: string }
 *   AUTOCOMPLETE  input: { query: string, sessionToken?: string }
 *   PLACE_DETAILS input: { placeId: string, sessionToken?: string }
 *
 * Returns Google-verified address components + coordinates. A signed short-lived
 * geocodeToken protects downstream writes from fabricated coordinates.
 */
import crypto from 'node:crypto'

const GEOCODE_TTL_DAYS = 30

function googleApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) throw new Error('Missing server configuration: GOOGLE_MAPS_API_KEY is not set')
  return key
}

function tokenSecret(): string {
  const secret = process.env.GEOCODE_TOKEN_SECRET
  if (!secret) throw new Error('Server configuration error: GEOCODE_TOKEN_SECRET is not set')
  return secret
}

const PAGE_GROUPS = ['page-customers', 'page-locations', 'page-loads']
const ADMIN_GROUP = 'ADMIN'

interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

interface AppSyncEvent {
  arguments: {
    action: string
    input: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

type GeocodeAction = 'GEOCODE' | 'AUTOCOMPLETE' | 'PLACE_DETAILS'

interface GeocodeInput {
  address: string
}

interface AutocompleteInput {
  query: string
  sessionToken?: string
}

interface PlaceDetailsInput {
  placeId: string
  sessionToken?: string
}

export interface Suggestion {
  placeId: string
  description: string
}

export interface GeocodeDetail {
  street: string
  city: string
  state: string
  zip: string
  country: string
  lat: number
  lng: number
  timezone: string
  placeId: string
  formattedAddress: string
  geocodedAt: string
  geocodeExpiresAt: string
  geocodeToken: string
}

type GeocodeResult = GeocodeDetail | { suggestions: Suggestion[] }

// ── Auth helpers ────────────────────────────────────────────────────────────

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function authorize(identity?: AppSyncIdentity | null): void {
  const groups = getGroups(identity)
  const isAdmin = groups.includes(ADMIN_GROUP)
  const hasPage = PAGE_GROUPS.some((g) => groups.includes(g))
  if (!isAdmin && !hasPage) {
    throw new Error('Forbidden: tmsGeocode requires ADMIN, page-customers, page-locations, or page-loads')
  }
}

// ── Input helpers ───────────────────────────────────────────────────────────

function parseInput(raw: string | Record<string, unknown> | null): Record<string, unknown> {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Invalid input: not valid JSON')
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }
  if (Array.isArray(raw) || typeof raw !== 'object') {
    throw new Error('Invalid input: must be a JSON object')
  }
  return raw
}

function requireString(value: unknown, name: string, maxLength = 1000): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} cannot be empty`)
  if (trimmed.length > maxLength) throw new Error(`${name} exceeds maximum length of ${maxLength}`)
  return trimmed
}

function optionalString(value: unknown, maxLength = 500): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('sessionToken must be a string')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) throw new Error(`sessionToken exceeds maximum length of ${maxLength}`)
  return trimmed
}

function parseAction(raw: string): GeocodeAction {
  if (raw !== 'GEOCODE' && raw !== 'AUTOCOMPLETE' && raw !== 'PLACE_DETAILS') {
    throw new Error(`Unsupported action: ${raw}`)
  }
  return raw
}

function validateGeocodeInput(raw: Record<string, unknown>): GeocodeInput {
  return { address: requireString(raw.address, 'address', 2000) }
}

function validateAutocompleteInput(raw: Record<string, unknown>): AutocompleteInput {
  return {
    query: requireString(raw.query, 'query', 500),
    sessionToken: optionalString(raw.sessionToken),
  }
}

function validatePlaceDetailsInput(raw: Record<string, unknown>): PlaceDetailsInput {
  return {
    placeId: requireString(raw.placeId, 'placeId', 500),
    sessionToken: optionalString(raw.sessionToken),
  }
}

// ── Token helpers ───────────────────────────────────────────────────────────

export interface TokenPayload {
  lat: number
  lng: number
  placeId: string
  geocodedAt: string
  geocodeExpiresAt: string
}

function base64url(input: string | Buffer): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buffer.toString('base64url')
}

export function signGeocodePayload(payload: TokenPayload): string {
  const secret = tokenSecret()
  const payloadJson = JSON.stringify(payload)
  const signature = crypto.createHmac('sha256', secret).update(payloadJson, 'utf8').digest()
  return `${base64url(payloadJson)}.${base64url(signature)}`
}

export function verifyGeocodeToken(token: string): TokenPayload {
  const secret = tokenSecret()
  const parts = token.split('.')
  if (parts.length !== 2) throw new Error('Invalid geocodeToken: malformed token')
  const [payloadPart, signaturePart] = parts
  let payloadJson: string
  try {
    payloadJson = Buffer.from(payloadPart, 'base64url').toString('utf8')
  } catch {
    throw new Error('Invalid geocodeToken: payload is not valid base64url')
  }
  let payload: TokenPayload
  try {
    payload = JSON.parse(payloadJson) as TokenPayload
  } catch {
    throw new Error('Invalid geocodeToken: payload is not valid JSON')
  }
  const expected = crypto.createHmac('sha256', secret).update(payloadJson, 'utf8').digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signaturePart, 'base64url')
  } catch {
    throw new Error('Invalid geocodeToken: signature is not valid base64url')
  }
  if (provided.length !== expected.length) {
    throw new Error('Invalid geocodeToken: signature length mismatch')
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    throw new Error('Invalid geocodeToken: signature verification failed')
  }
  return payload
}

function mintGeocodeToken(detail: Pick<GeocodeDetail, 'lat' | 'lng' | 'placeId'> & { geocodedAt: string; geocodeExpiresAt: string }): string {
  return signGeocodePayload({
    lat: detail.lat,
    lng: detail.lng,
    placeId: detail.placeId,
    geocodedAt: detail.geocodedAt,
    geocodeExpiresAt: detail.geocodeExpiresAt,
  })
}

// ── Google helpers ────────────────────────────────────────────────────────

interface FetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

async function googleJson<T = Record<string, unknown>>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  })
  if (!response.ok) {
    throw new Error(`Google API returned HTTP ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  const status = typeof data.status === 'string' ? data.status : undefined
  if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
    const message = typeof data.error_message === 'string' ? data.error_message : status
    throw new Error(`Google API error: ${message}`)
  }
  return data as T
}

function normalizePlaceId(raw: string): string {
  return raw.replace(/^places\//, '')
}

// ── Address parsing helpers ─────────────────────────────────────────────────

type AddressComponent = {
  long_name: string
  short_name: string
  types: string[]
}

type NewAddressComponent = {
  longText: string
  shortText: string
  types: string[]
}

function parseLegacyAddressComponents(components: AddressComponent[]) {
  const find = (types: string[], by: 'long' | 'short') => {
    for (const type of types) {
      const found = components.find((c) => c.types.includes(type))
      if (found) return by === 'short' ? found.short_name : found.long_name
    }
    return ''
  }
  const streetNumber = find(['street_number'], 'long')
  const route = find(['route'], 'long')
  const street = [streetNumber, route].filter(Boolean).join(' ')
  const city = find(['locality'], 'long') || find(['sublocality_level_1'], 'long')
  const state = find(['administrative_area_level_1'], 'short')
  const zip = find(['postal_code'], 'long')
  const country = find(['country'], 'short')
  return { street, city, state, zip, country }
}

function parseNewAddressComponents(components: NewAddressComponent[]) {
  const find = (types: string[], by: 'long' | 'short') => {
    for (const type of types) {
      const found = components.find((c) => c.types.includes(type))
      if (found) return by === 'short' ? found.shortText : found.longText
    }
    return ''
  }
  const streetNumber = find(['street_number'], 'long')
  const route = find(['route'], 'long')
  const street = [streetNumber, route].filter(Boolean).join(' ')
  const city = find(['locality'], 'long') || find(['sublocality_level_1'], 'long')
  const state = find(['administrative_area_level_1'], 'short')
  const zip = find(['postal_code'], 'long')
  const country = find(['country'], 'short')
  return { street, city, state, zip, country }
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1e7) / 1e7
}

function geocodeWindow(): { geocodedAt: string; geocodeExpiresAt: string } {
  const geocodedAt = new Date()
  const geocodeExpiresAt = new Date(geocodedAt.getTime() + GEOCODE_TTL_DAYS * 24 * 60 * 60 * 1000)
  return { geocodedAt: geocodedAt.toISOString(), geocodeExpiresAt: geocodeExpiresAt.toISOString() }
}

async function fetchTimezone(lat: number, lng: number): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${timestamp}&key=${googleApiKey()}`
  const data = await googleJson<{
    status: string
    timeZoneId?: string
    error_message?: string
  }>(url)
  if (!data.timeZoneId) {
    throw new Error('Google Time Zone API did not return a timezone')
  }
  return data.timeZoneId
}

async function buildDetail(
  placeId: string,
  formattedAddress: string,
  lat: number,
  lng: number,
  parsed: { street: string; city: string; state: string; zip: string; country: string },
): Promise<GeocodeDetail> {
  const { geocodedAt, geocodeExpiresAt } = geocodeWindow()
  const timezone = await fetchTimezone(lat, lng)
  const detail: GeocodeDetail = {
    ...parsed,
    lat: roundCoordinate(lat),
    lng: roundCoordinate(lng),
    timezone,
    placeId,
    formattedAddress,
    geocodedAt,
    geocodeExpiresAt,
    geocodeToken: '',
  }
  detail.geocodeToken = mintGeocodeToken(detail)
  return detail
}

// ── Action implementations ──────────────────────────────────────────────────

async function geocodeAddress(address: string): Promise<GeocodeDetail> {
  const encoded = encodeURIComponent(address)
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${googleApiKey()}`
  const data = await googleJson<{
    status: string
    results?: Array<{
      place_id: string
      formatted_address: string
      geometry: { location: { lat: number; lng: number } }
      address_components: AddressComponent[]
    }>
    error_message?: string
  }>(url)

  if (data.status === 'ZERO_RESULTS' || !data.results || data.results.length === 0) {
    throw new Error('No geocoding results found')
  }

  const first = data.results[0]
  const parsed = parseLegacyAddressComponents(first.address_components)
  return buildDetail(
    first.place_id,
    first.formatted_address,
    first.geometry.location.lat,
    first.geometry.location.lng,
    parsed,
  )
}

async function autocompletePlaces(query: string, sessionToken?: string): Promise<{ suggestions: Suggestion[] }> {
  const token = sessionToken ?? crypto.randomUUID()
  const url = 'https://places.googleapis.com/v1/places:autocomplete'
  const data = await googleJson<{
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string
        text?: { text?: string }
      }
    }>
  }>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleApiKey(),
    },
    body: JSON.stringify({ input: query, sessionToken: token }),
  })

  const suggestions: Suggestion[] =
    data.suggestions
      ?.map((s) => {
        const prediction = s.placePrediction
        if (!prediction?.placeId || prediction.text?.text == null) return null
        return {
          placeId: prediction.placeId,
          description: prediction.text.text,
        }
      })
      .filter((s): s is Suggestion => s !== null) ?? []

  return { suggestions }
}

async function placeDetails(placeId: string, sessionToken?: string): Promise<GeocodeDetail> {
  const normalizedId = normalizePlaceId(placeId)
  const encodedId = encodeURIComponent(normalizedId)
  const sessionParam = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ''
  const url = `https://places.googleapis.com/v1/places/${encodedId}${sessionParam}`
  const headers: Record<string, string> = {
    'X-Goog-Api-Key': googleApiKey(),
    'X-Goog-FieldMask': 'name,formattedAddress,addressComponents,location',
  }

  const data = await googleJson<{
    name?: string
    formattedAddress?: string
    addressComponents?: NewAddressComponent[]
    location?: { latitude: number; longitude: number }
  }>(url, { headers })

  if (!data.location) {
    throw new Error('Google Place Details did not return a location')
  }

  const parsed = parseNewAddressComponents(data.addressComponents ?? [])
  const finalPlaceId = normalizePlaceId(data.name ?? normalizedId)
  return buildDetail(
    finalPlaceId,
    data.formattedAddress ?? '',
    data.location.latitude,
    data.location.longitude,
    parsed,
  )
}

// ── Handler ────────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<GeocodeResult> => {
  authorize(event.identity ?? null)
  // Fail fast if server secrets are missing; never log secret values.
  googleApiKey()
  tokenSecret()

  const action = parseAction(requireString(event.arguments?.action, 'action', 50))
  const input = parseInput(event.arguments?.input ?? null)

  try {
    switch (action) {
      case 'GEOCODE': {
        const { address } = validateGeocodeInput(input)
        return await geocodeAddress(address)
      }
      case 'AUTOCOMPLETE': {
        const { query, sessionToken } = validateAutocompleteInput(input)
        return await autocompletePlaces(query, sessionToken)
      }
      case 'PLACE_DETAILS': {
        const { placeId, sessionToken } = validatePlaceDetailsInput(input)
        return await placeDetails(placeId, sessionToken)
      }
    }
  } catch (err) {
    // Surface upstream / validation errors without leaking secrets.
    const message = err instanceof Error ? err.message : String(err)
    const error = new Error(message)
    ;(error as Error & { cause?: unknown }).cause = err
    throw error
  }
}
