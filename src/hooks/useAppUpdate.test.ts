// @vitest-environment jsdom
/**
 * Noticing a deploy. The point of this is that a tab open since before a deploy stops
 * silently running old code — so the cases that matter are: it does not cry wolf on the
 * first look, and it does not go quiet when the network does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAppUpdate } from './useAppUpdate'

function html(bundle: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="${bundle}"></script></head><body></body></html>`
}

function respondWith(bundles: string[]) {
  let i = 0
  return vi.fn(async () => {
    const b = bundles[Math.min(i++, bundles.length - 1)]
    return { ok: true, text: async () => html(b) } as unknown as Response
  })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('useAppUpdate', () => {
  it('says nothing on the first look', async () => {
    // The first fetch establishes what this tab is running; it is not evidence of a deploy.
    vi.stubGlobal('fetch', respondWith(['/assets/index-AAA.js']))
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(result.current.available).toBe(false)
  })

  it('stays quiet while the bundle is unchanged', async () => {
    vi.stubGlobal('fetch', respondWith(['/assets/index-AAA.js']))
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000) })
    expect(result.current.available).toBe(false)
  })

  it('reports an update once the bundle name changes', async () => {
    vi.stubGlobal('fetch', respondWith(['/assets/index-AAA.js', '/assets/index-BBB.js']))
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000) })
    expect(result.current.available).toBe(true)
  })

  it('does not treat a failed fetch as a new version', async () => {
    /*
     * Offline is not out of date. Reporting an update a driver cannot download, or that
     * does not exist, is how a banner becomes something people click past without reading.
     */
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000) })
    expect(result.current.available).toBe(false)
  })

  it('does not treat a non-200 as a new version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' }) as unknown as Response))
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000) })
    expect(result.current.available).toBe(false)
  })

  it('does not flap back to "no update" once it has seen one', async () => {
    // The baseline stays the build this tab is running, so a later check cannot clear it.
    vi.stubGlobal('fetch', respondWith(['/assets/index-AAA.js', '/assets/index-BBB.js', '/assets/index-BBB.js']))
    const { result } = renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000) })
    expect(result.current.available).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000) })
    expect(result.current.available).toBe(true)
  })

  it('asks the server rather than the cache', async () => {
    const fetchMock = respondWith(['/assets/index-AAA.js'])
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useAppUpdate())
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(fetchMock).toHaveBeenCalledWith('/index.html', { cache: 'no-store' })
  })
})
