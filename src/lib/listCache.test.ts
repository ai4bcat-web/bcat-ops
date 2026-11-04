import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cachedList, invalidateLists, peekList, readList } from './listCache'

beforeEach(() => {
  invalidateLists()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('listCache', () => {
  it('shares one request between simultaneous callers', async () => {
    const load = vi.fn(async () => [1, 2])
    const [a, b] = await Promise.all([
      cachedList('k', load, { ttlMs: 1000 }),
      cachedList('k', load, { ttlMs: 1000 }),
    ])
    expect(load).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('serves fresh without a request, stale now with exactly one background refresh, and nothing past staleMs', async () => {
    let n = 0
    const load = vi.fn(async () => ++n)
    const opts = { ttlMs: 1000, staleMs: 5000 }
    expect(await cachedList('k', load, opts)).toBe(1)
    vi.advanceTimersByTime(500)
    expect(await cachedList('k', load, opts)).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000) // stale
    const r1 = readList('k', load, opts)
    const r2 = readList('k', load, opts)
    expect(r1.value).toBe(1)
    expect(r2.value).toBe(1)
    expect(await r1.fresh).toBe(2)
    expect(load).toHaveBeenCalledTimes(2)
    expect(peekList('k')).toBe(2)

    vi.advanceTimersByTime(10_000) // past stale: must wait for the load
    const r3 = readList('k', load, opts)
    expect(r3.value).toBeUndefined()
    expect(await r3.fresh).toBe(3)
  })

  it('never caches a rejected load', async () => {
    const load = vi.fn<() => Promise<string>>()
    load.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok')
    await expect(cachedList('k', load, { ttlMs: 1000 })).rejects.toThrow('boom')
    expect(peekList('k')).toBeUndefined()
    expect(await cachedList('k', load, { ttlMs: 1000 })).toBe('ok')
  })

  it('invalidates by prefix only', async () => {
    await cachedList('directory:a', async () => 'a', { ttlMs: 1000 })
    await cachedList('board:b', async () => 'b', { ttlMs: 1000 })
    invalidateLists('directory:')
    expect(peekList('directory:a')).toBeUndefined()
    expect(peekList('board:b')).toBe('b')
    invalidateLists()
    expect(peekList('board:b')).toBeUndefined()
  })

  it('a read that started before a write cannot repopulate the cache with pre-write data', async () => {
    let release!: (v: string) => void
    const slow = new Promise<string>((r) => { release = r })
    const pending = cachedList('k', () => slow, { ttlMs: 1000 })
    invalidateLists()
    release('stale')
    expect(await pending).toBe('stale') // the caller that asked still gets its answer
    expect(peekList('k')).toBeUndefined() // but later callers re-read
  })

  it('force re-reads a fresh entry', async () => {
    let n = 0
    const load = async () => ++n
    await cachedList('k', load, { ttlMs: 1000 })
    expect(await cachedList('k', load, { ttlMs: 1000, force: true })).toBe(2)
  })
})
