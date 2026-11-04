import { describe, it, expect, vi } from 'vitest'
import { resolveShareLink, simPings, simText, type SimDeps } from './shareIngest'

const ADMIN = { email: 'admin@bcatcorp.com', sub: 'sub-admin', groups: ['ADMIN'], isAdmin: true }
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

describe('resolveShareLink', () => {
  it('follows allow-listed redirects to a URL that carries coordinates', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(redirect('https://www.google.com/maps/place/x/@41.6,-87.3,17z'))
    expect(await resolveShareLink('https://maps.app.goo.gl/abc', fetchFn as never)).toBe('https://www.google.com/maps/place/x/@41.6,-87.3,17z')
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('refuses a hop that leaves the allow-list and never fetches it', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(redirect('https://evil.example/steal'))
    expect(await resolveShareLink('https://maps.app.goo.gl/abc', fetchFn as never)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refuses a first URL off the allow-list without any request', async () => {
    const fetchFn = vi.fn()
    expect(await resolveShareLink('http://maps.app.goo.gl/abc', fetchFn as never)).toBeNull()
    expect(await resolveShareLink('https://goo.gl.evil.com/maps/abc', fetchFn as never)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('gives up after three redirects', async () => {
    const fetchFn = vi.fn(async () => redirect('https://goo.gl/maps/next'))
    expect(await resolveShareLink('https://goo.gl/maps/first', fetchFn as never)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
})

function simDeps(over: Partial<SimDeps> = {}): SimDeps {
  return {
    isDevStack: () => true,
    now: () => '2026-11-04T12:00:00.000Z',
    getLoad: async (id) => (id === 'lod-1' ? { id } : null),
    putPing: vi.fn(async () => 'WRITTEN' as const),
    thread: {} as never,
    ...over,
  }
}

describe('sim doors', () => {
  it('refuse outside the dev stack and for non-admins', async () => {
    const input = { loadId: 'lod-1', fixes: [{ minutesAgo: 5, lat: 41.5, lng: -88.1, source: 'link' }] }
    await expect(simPings(simDeps({ isDevStack: () => false }), input, ADMIN)).rejects.toThrow('This action only exists on the dev stack')
    await expect(simText(simDeps({ isDevStack: () => false }), { shipmentId: 's', body: 'x' }, ADMIN)).rejects.toThrow('only exists on the dev stack')
    await expect(simPings(simDeps(), input, { ...ADMIN, isAdmin: false })).rejects.toThrow(/ADMIN/)
  })

  it('TRACKING_SIM_PINGS writes each fix back-dated from now and counts duplicates', async () => {
    const putPing = vi.fn()
      .mockResolvedValueOnce('WRITTEN')
      .mockResolvedValueOnce('DUPLICATE')
    const out = await simPings(simDeps({ putPing }), {
      loadId: 'lod-1',
      fixes: [
        { minutesAgo: 30, lat: 41.5, lng: -88.1, source: 'link', accuracyM: 20 },
        { minutesAgo: 10, lat: 41.6, lng: -87.3, source: 'sms-geocode', approx: true, place: 'Gary, IN' },
      ],
    }, ADMIN)
    expect(out).toMatchObject({ written: 1, duplicates: 1 })
    expect(putPing.mock.calls[0]?.[0]).toMatchObject({ loadId: 'lod-1', at: '2026-11-04T11:30:00.000Z', source: 'link', accuracyM: 20 })
    expect(putPing.mock.calls[1]?.[0]).toMatchObject({ approx: true, place: 'Gary, IN' })
  })

  it('TRACKING_SIM_PINGS rejects a bad source and a missing load', async () => {
    await expect(simPings(simDeps(), { loadId: 'lod-1', fixes: [{ minutesAgo: 1, lat: 1, lng: 1, source: 'bogus' }] }, ADMIN)).rejects.toThrow(/source/)
    await expect(simPings(simDeps(), { loadId: 'nope', fixes: [{ minutesAgo: 1, lat: 1, lng: 1, source: 'link' }] }, ADMIN)).rejects.toThrow(/not found/)
  })
})
