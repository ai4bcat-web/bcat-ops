import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GeocodeDetail } from './handler'
import { handler, verifyGeocodeToken } from './handler'

process.env.GOOGLE_MAPS_API_KEY = 'test-google-key'
process.env.GEOCODE_TOKEN_SECRET = 'test-token-secret-32-bytes-long-string'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const DAY_MS = 24 * 60 * 60 * 1000

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function event(
  action: string,
  input: Record<string, unknown>,
  groups: string[] = ['page-loads'],
) {
  return {
    arguments: { action, input: JSON.stringify(input) },
    identity: {
      sub: 'sub-123',
      username: 'user@bcatcorp.com',
      claims: { 'cognito:groups': groups },
    },
  }
}

const geocodeOkBody = {
  status: 'OK',
  results: [
    {
      place_id: 'ChIJ123',
      formatted_address: '123 Main St, Springfield, IL 62701, USA',
      geometry: { location: { lat: 39.7817213, lng: -89.6501481 } },
      address_components: [
        { long_name: '123', short_name: '123', types: ['street_number'] },
        { long_name: 'Main Street', short_name: 'Main St', types: ['route'] },
        { long_name: 'Springfield', short_name: 'Springfield', types: ['locality'] },
        { long_name: 'Illinois', short_name: 'IL', types: ['administrative_area_level_1'] },
        { long_name: '62701', short_name: '62701', types: ['postal_code'] },
        { long_name: 'United States', short_name: 'US', types: ['country'] },
      ],
    },
  ],
}

const timezoneOkBody = {
  status: 'OK',
  timeZoneId: 'America/Chicago',
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('tms-geocode handler', () => {
  it('GEOCODE returns address components, coordinates, timezone and signed token', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(geocodeOkBody))
      .mockResolvedValueOnce(mockResponse(timezoneOkBody))

    const result = (await handler(event('GEOCODE', { address: '123 Main St, Springfield IL' }))) as GeocodeDetail

    expect(result.street).toBe('123 Main Street')
    expect(result.city).toBe('Springfield')
    expect(result.state).toBe('IL')
    expect(result.zip).toBe('62701')
    expect(result.country).toBe('US')
    expect(result.lat).toBe(39.7817213)
    expect(result.lng).toBe(-89.6501481)
    expect(result.timezone).toBe('America/Chicago')
    expect(result.placeId).toBe('ChIJ123')
    expect(result.formattedAddress).toBe('123 Main St, Springfield, IL 62701, USA')
    expect(result.geocodedAt).toBeTruthy()
    expect(result.geocodeExpiresAt).toBeTruthy()
    expect(result.geocodeToken).toBeTruthy()

    const payload = verifyGeocodeToken(result.geocodeToken)
    expect(payload.lat).toBe(result.lat)
    expect(payload.lng).toBe(result.lng)
    expect(payload.placeId).toBe(result.placeId)
    expect(payload.geocodedAt).toBe(result.geocodedAt)
    expect(payload.geocodeExpiresAt).toBe(result.geocodeExpiresAt)

    const ttl = new Date(payload.geocodeExpiresAt).getTime() - new Date(payload.geocodedAt).getTime()
    expect(ttl).toBeGreaterThan(29 * DAY_MS)
    expect(ttl).toBeLessThanOrEqual(30 * DAY_MS + 1000)
  })

  it('AUTOCOMPLETE returns suggestions', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        suggestions: [
          {
            placePrediction: {
              placeId: 'ChIJabc',
              text: { text: '123 Main Street, Springfield, IL, USA' },
            },
          },
          {
            placePrediction: {
              placeId: 'ChIJdef',
              text: { text: '123 Main Avenue, Springfield, IL, USA' },
            },
          },
        ],
      }),
    )

    const result = await handler(event('AUTOCOMPLETE', { query: '123 Main St, Springfield' }))

    expect('suggestions' in result).toBe(true)
    if ('suggestions' in result) {
      expect(result.suggestions).toHaveLength(2)
      expect(result.suggestions[0]).toEqual({
        placeId: 'ChIJabc',
        description: '123 Main Street, Springfield, IL, USA',
      })
    }
  })

  it('PLACE_DETAILS returns detail and timezone', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          name: 'places/ChIJ123',
          formattedAddress: '123 Main St, Springfield, IL 62701, USA',
          addressComponents: [
            { longText: '123', shortText: '123', types: ['street_number'] },
            { longText: 'Main Street', shortText: 'Main St', types: ['route'] },
            { longText: 'Springfield', shortText: 'Springfield', types: ['locality'] },
            { longText: 'Illinois', shortText: 'IL', types: ['administrative_area_level_1'] },
            { longText: '62701', shortText: '62701', types: ['postal_code'] },
            { longText: 'United States', shortText: 'US', types: ['country'] },
          ],
          location: { latitude: 39.7817213, longitude: -89.6501481 },
        }),
      )
      .mockResolvedValueOnce(mockResponse(timezoneOkBody))

    const result = (await handler(
      event('PLACE_DETAILS', { placeId: 'ChIJ123', sessionToken: 'session-abc' }),
    )) as GeocodeDetail

    expect(result.placeId).toBe('ChIJ123')
    expect(result.lat).toBe(39.7817213)
    expect(result.lng).toBe(-89.6501481)
    expect(result.timezone).toBe('America/Chicago')
    expect(result.geocodeToken).toBeTruthy()
  })

  it('fails with descriptive message when upstream denies the request', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 'REQUEST_DENIED',
        error_message: 'The provided API key is invalid.',
      }),
    )

    const err = handler(event('GEOCODE', { address: 'test' }))
    await expect(err).rejects.toThrow('Google API error: The provided API key is invalid.')
    await expect(err).rejects.toThrow(expect.not.stringContaining('test-google-key'))
  })

  it('fails when geocoding returns zero results', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 'ZERO_RESULTS', results: [] }))

    await expect(handler(event('GEOCODE', { address: 'nowheresville' }))).rejects.toThrow(
      'No geocoding results found',
    )
  })

  it('fails when GOOGLE_MAPS_API_KEY is missing', async () => {
    const savedKey = process.env.GOOGLE_MAPS_API_KEY
    process.env.GOOGLE_MAPS_API_KEY = ''
    await expect(handler(event('GEOCODE', { address: 'test' }))).rejects.toThrow(
      'Missing server configuration: GOOGLE_MAPS_API_KEY is not set',
    )
    process.env.GOOGLE_MAPS_API_KEY = savedKey
  })

  it('fails when GEOCODE_TOKEN_SECRET is missing', async () => {
    const savedSecret = process.env.GEOCODE_TOKEN_SECRET
    process.env.GEOCODE_TOKEN_SECRET = ''
    await expect(handler(event('GEOCODE', { address: 'test' }))).rejects.toThrow(
      'Server configuration error: GEOCODE_TOKEN_SECRET is not set',
    )
    process.env.GEOCODE_TOKEN_SECRET = savedSecret
  })

  it('fails when Time Zone API errors', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(geocodeOkBody))
      .mockResolvedValueOnce(
        mockResponse({
          status: 'REQUEST_DENIED',
          error_message: 'The provided API key is invalid.',
        }),
      )

    await expect(handler(event('GEOCODE', { address: 'test' }))).rejects.toThrow('Google API error')
  })

  it('rejects a tampered geocodeToken', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(geocodeOkBody))
      .mockResolvedValueOnce(mockResponse(timezoneOkBody))

    const result = (await handler(event('GEOCODE', { address: '123 Main St' }))) as GeocodeDetail
    const token = result.geocodeToken
    const [payloadPart, signaturePart] = token.split('.')

    // Tamper with the payload: change latitude.
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
    payload.lat = 0
    const tamperedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const tamperedToken = `${tamperedPayload}.${signaturePart}`

    expect(() => verifyGeocodeToken(tamperedToken)).toThrow('signature verification failed')
  })

  it('rejects calls without required page-level authorization', async () => {
    await expect(
      handler({ arguments: { action: 'GEOCODE', input: '{"address":"test"}' }, identity: null }),
    ).rejects.toThrow('Forbidden')
  })

  it('rejects unsupported actions', async () => {
    await expect(handler(event('UNKNOWN', { address: 'test' }))).rejects.toThrow(
      'Unsupported action: UNKNOWN',
    )
  })
})
