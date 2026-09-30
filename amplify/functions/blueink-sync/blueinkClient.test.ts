import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchVehicleLocations } from './blueinkClient'

const fetchMock = vi.fn()

function bitResponse(vehicles: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () =>
      JSON.stringify({ vehicles, pagination: { per_page: 100, page_no: 1, total: vehicles.length } }),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchVehicleLocations', () => {
  it('reports the reason a vehicle has no fix instead of skipping silently', async () => {
    // Verbatim shape returned by Blue Ink for unit 310 on 2026-09-30: the vehicle is
    // listed, but its GPS is withheld behind a subscription tier. Skipping quietly made
    // this look like an empty API response for ~19 hours.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue(bitResponse([
      {
        vehicle: {
          id: '176260', number: '310', make: 'KENWORTH', model: 'T680',
          current_location: { error: 'Vehicle requires BIT Full Service' },
        },
      },
    ]))

    const out = await fetchVehicleLocations('key')

    expect(out).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('310'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vehicle requires BIT Full Service'))
  })

  it('returns a usable fix when Blue Ink supplies coordinates', async () => {
    fetchMock.mockResolvedValue(bitResponse([
      {
        vehicle: {
          id: '176260', number: '310',
          current_location: { lat: '34.15155', lon: '-111.31563', located_at: '2026-09-30 00:38:12', speed_mph: '18.1' },
        },
      },
    ]))

    const out = await fetchVehicleLocations('key')

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ number: '310', lat: 34.15155, lon: -111.31563, speed: 18.1 })
    // BIT never sends a place name; the handler reverse-geocodes when it can.
    expect(out[0].description).toBeNull()
  })
})
