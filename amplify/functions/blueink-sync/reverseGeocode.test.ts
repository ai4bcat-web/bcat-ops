/**
 * reverseGeocode unit tests.
 *
 * The Google Geocoding API is mocked via vi.stubGlobal('fetch', ...), matching the
 * pattern used in amplify/functions/appt-need-notifier/handler.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<(url: string) => Promise<Response>>()
vi.stubGlobal('fetch', fetchMock)

import { reverseGeocode } from './reverseGeocode'

const mockResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

const paysonResponse = {
  status: 'OK',
  results: [
    {
      address_components: [
        { long_name: 'Payson', short_name: 'Payson', types: ['locality', 'political'] },
        { long_name: 'Gila County', short_name: 'Gila County', types: ['administrative_area_level_2', 'political'] },
        { long_name: 'Arizona', short_name: 'AZ', types: ['administrative_area_level_1', 'political'] },
        { long_name: 'United States', short_name: 'US', types: ['country', 'political'] },
      ],
    },
  ],
}

beforeEach(() => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google-key'
  fetchMock.mockReset()
})

describe('reverseGeocode', () => {
  it('returns "City, ST" for a well-formed Google response', async () => {
    fetchMock.mockResolvedValue(mockResponse(paysonResponse))

    const result = await reverseGeocode(34.15155, -111.31563)

    expect(result).toBe('Payson, AZ')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0]
    expect(typeof url).toBe('string')
    expect(url).toContain('latlng=34.15155%2C-111.31563')
    expect(url).toContain('key=test-google-key')
  })

  it('returns null when the API key is missing', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY
    fetchMock.mockResolvedValue(mockResponse(paysonResponse))

    const result = await reverseGeocode(34.15155, -111.31563)

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when Google responds with a non-OK status', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 'ZERO_RESULTS', results: [] }))

    const result = await reverseGeocode(34.15155, -111.31563)

    expect(result).toBeNull()
  })

  it('returns null when the fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    const result = await reverseGeocode(34.15155, -111.31563)

    expect(result).toBeNull()
  })

  it('returns null when no usable locality component exists', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 'OK',
        results: [
          {
            address_components: [
              { long_name: 'Arizona', short_name: 'AZ', types: ['administrative_area_level_1', 'political'] },
              { long_name: 'United States', short_name: 'US', types: ['country', 'political'] },
            ],
          },
        ],
      }),
    )

    const result = await reverseGeocode(34.15155, -111.31563)

    expect(result).toBeNull()
  })

  it('falls back through postal_town / sublocality / admin_area_level_2 before giving up', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 'OK',
        results: [
          {
            address_components: [
              { long_name: 'Willowbrook', short_name: 'Willowbrook', types: ['sublocality_level_1', 'sublocality', 'political'] },
              { long_name: 'Illinois', short_name: 'IL', types: ['administrative_area_level_1', 'political'] },
            ],
          },
        ],
      }),
    )

    const result = await reverseGeocode(41.75, -87.93)

    expect(result).toBe('Willowbrook, IL')
  })
})
