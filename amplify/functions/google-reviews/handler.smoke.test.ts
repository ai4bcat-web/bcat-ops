import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const FALLBACK_URL = 'https://www.google.com/maps?cid=2781568378344970342'

let fetchMock: ReturnType<typeof vi.fn>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  delete process.env.GOOGLE_PLACES_API_KEY
  delete process.env.GOOGLE_PLACE_ID
  delete process.env.GOOGLE_PLACE_QUERY
  delete process.env.GOOGLE_REVIEWS_URL
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  warn.mockRestore()
  error.mockRestore()
  delete process.env.GOOGLE_PLACES_API_KEY
  delete process.env.GOOGLE_PLACE_ID
})

const jsonResponse = (body: unknown) => ({ json: async () => body })

describe('google-reviews handler', () => {
  it('loads with empty env and returns the fallback link, unconfigured, without any fetch', async () => {
    const { handler } = await import('./handler')
    expect(await handler()).toEqual({ configured: false, ok: false, rating: null, total: null, url: FALLBACK_URL })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the listing via Find Place and caches the result', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'key'
    fetchMock.mockResolvedValue(jsonResponse({ status: 'OK', candidates: [{ place_id: 'PID', rating: 4.9, user_ratings_total: 127 }] }))
    const { handler } = await import('./handler')
    const expected = {
      configured: true, ok: true, rating: 4.9, total: 127,
      url: 'https://search.google.com/local/reviews?placeid=PID',
    }
    expect(await handler()).toEqual(expected)
    expect(await handler()).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('findplacefromtext')
  })

  it('uses Place Details when a place id is configured', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'key'
    process.env.GOOGLE_PLACE_ID = 'PID2'
    fetchMock.mockResolvedValue(jsonResponse({ status: 'OK', result: { rating: 4.5, user_ratings_total: 10 } }))
    const { handler } = await import('./handler')
    expect(await handler()).toEqual({
      configured: true, ok: true, rating: 4.5, total: 10,
      url: 'https://search.google.com/local/reviews?placeid=PID2',
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/place/details/json')
  })

  it('reports the API status when Google rejects the request', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'key'
    fetchMock.mockResolvedValue(jsonResponse({ status: 'REQUEST_DENIED', error_message: 'bad key' }))
    const { handler } = await import('./handler')
    expect(await handler()).toEqual({ configured: true, ok: false, rating: null, total: null, url: FALLBACK_URL, error: 'REQUEST_DENIED' })
  })

  it('returns fetch-failed when the network call throws', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'key'
    fetchMock.mockRejectedValue(new Error('offline'))
    const { handler } = await import('./handler')
    expect(await handler()).toEqual({ configured: true, ok: false, rating: null, total: null, url: FALLBACK_URL, error: 'fetch-failed' })
  })
})
