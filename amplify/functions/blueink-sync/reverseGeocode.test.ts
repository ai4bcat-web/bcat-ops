import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reverseGeocode, censusReverseGeocode } from './reverseGeocode'

const ROY = { lat: 43.036104403031, lon: -89.268560647168 } // unit 310, near Madison WI

function jsonOnce(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch
}

const CENSUS_OK = {
  result: {
    geographies: {
      'Incorporated Places': [{ NAME: 'Madison city', BASENAME: 'Madison' }],
      Counties: [{ NAME: 'Dane County', BASENAME: 'Dane' }],
      States: [{ NAME: 'Wisconsin', STUSAB: 'WI' }],
    },
  },
}

const GOOGLE_DENIED = {
  status: 'REQUEST_DENIED',
  error_message: 'This API is not activated on your API project.',
}

const GOOGLE_OK = {
  status: 'OK',
  results: [{
    address_components: [
      { long_name: 'Monona', short_name: 'Monona', types: ['locality'] },
      { long_name: 'Wisconsin', short_name: 'WI', types: ['administrative_area_level_1'] },
    ],
  }],
}

beforeEach(() => { delete process.env.GOOGLE_PLACES_API_KEY })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GOOGLE_PLACES_API_KEY })

describe('reverseGeocode', () => {
  it('uses Google when its key works', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'k'
    const fetchMock = jsonOnce(GOOGLE_OK)
    vi.stubGlobal('fetch', fetchMock)
    expect(await reverseGeocode(ROY.lat, ROY.lon)).toBe('Monona, WI')
    expect(fetchMock).toHaveBeenCalledTimes(1) // never reached the fallback
  })

  it('falls back to the Census when Google refuses the Geocoding API', async () => {
    /*
     * The real failure. The key was valid and the Geocoding API simply was not enabled on
     * the project, so every call came back REQUEST_DENIED and every Blue Ink truck stored a
     * null description — which the dashboard rendered as raw coordinates.
     */
    process.env.GOOGLE_PLACES_API_KEY = 'k'
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url))
      const body = String(url).includes('census') ? CENSUS_OK : GOOGLE_DENIED
      return { ok: true, json: async () => body }
    }) as unknown as typeof fetch)

    expect(await reverseGeocode(ROY.lat, ROY.lon)).toBe('Madison, WI')
    expect(calls[0]).toContain('maps.googleapis.com')
    expect(calls[1]).toContain('geocoding.geo.census.gov')
  })

  it('works with no Google key at all', async () => {
    vi.stubGlobal('fetch', jsonOnce(CENSUS_OK))
    expect(await reverseGeocode(ROY.lat, ROY.lon)).toBe('Madison, WI')
  })

  it('returns null when both sources fail, so the sync is never aborted', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'k'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch)
    expect(await reverseGeocode(ROY.lat, ROY.lon)).toBeNull()
  })
})

describe('censusReverseGeocode', () => {
  it('strips the legal suffix from a place name', async () => {
    // NAME is "Madison city"; BASENAME is the bare town.
    vi.stubGlobal('fetch', jsonOnce(CENSUS_OK))
    expect(await censusReverseGeocode(ROY.lat, ROY.lon)).toBe('Madison, WI')
  })

  it('names the county when a point is outside any town', async () => {
    // Most of an interstate. Still somewhere a dispatcher can picture.
    vi.stubGlobal('fetch', jsonOnce({
      result: { geographies: {
        Counties: [{ NAME: 'Dane County', BASENAME: 'Dane' }],
        States: [{ NAME: 'Wisconsin', STUSAB: 'WI' }],
      } },
    }))
    expect(await censusReverseGeocode(ROY.lat, ROY.lon)).toBe('Dane County, WI')
  })

  it('prefers a census designated place over the county', async () => {
    vi.stubGlobal('fetch', jsonOnce({
      result: { geographies: {
        'Census Designated Places': [{ NAME: 'Blooming Grove CDP', BASENAME: 'Blooming Grove' }],
        Counties: [{ NAME: 'Dane County', BASENAME: 'Dane' }],
        States: [{ NAME: 'Wisconsin', STUSAB: 'WI' }],
      } },
    }))
    expect(await censusReverseGeocode(ROY.lat, ROY.lon)).toBe('Blooming Grove, WI')
  })

  it('returns null without a state, rather than a half label', async () => {
    vi.stubGlobal('fetch', jsonOnce({ result: { geographies: { 'Incorporated Places': [{ BASENAME: 'Madison' }] } } }))
    expect(await censusReverseGeocode(ROY.lat, ROY.lon)).toBeNull()
  })

  it('returns null on a non-OK response or bad coordinates', async () => {
    vi.stubGlobal('fetch', jsonOnce({}, false))
    expect(await censusReverseGeocode(ROY.lat, ROY.lon)).toBeNull()
    vi.stubGlobal('fetch', jsonOnce(CENSUS_OK))
    expect(await censusReverseGeocode(Number.NaN, ROY.lon)).toBeNull()
  })
})
