// Runs one hook against the full store and against the windowed store (PERF plan I5).
import { expect } from 'vitest'
import { waitFor, act } from '@testing-library/react'
import { monthsCovering } from '@/lib/shipmentWindows'
import { useAppStore } from '@/store/useAppStore'
import { FIXTURE_DRIVERS, FIXTURE_LOADS, isOpen, monthOf } from './loadWindowFixture'

/** The store as it was before windowing: every load, every month marked loaded. */
export function seedFullStore() {
  useAppStore.setState({
    loads: FIXTURE_LOADS,
    loadedMonths: new Set(FIXTURE_LOADS.map(monthOf)),
    drivers: FIXTURE_DRIVERS,
  })
}

/** The store after boot but before any page asked for a range: just the open loads. */
export function seedWindowedStore() {
  useAppStore.setState({
    loads: FIXTURE_LOADS.filter(isOpen),
    loadedMonths: new Set<string>(),
    drivers: FIXTURE_DRIVERS,
  })
}

/**
 * Render `hook` against the full store, then against the windowed store, and hand back
 * what `pick` reads off each once `settled` holds and every month of the range (±1) the
 * hook should have asked for is in. The windowed run must really be smaller.
 */
export async function computeFullAndWindowed<T, P>(opts: {
  render: () => { result: { current: T }; unmount: () => void }
  from: string
  to: string
  pick: (r: T) => P
  settled: (r: T) => boolean
}): Promise<{ full: P; windowed: P; fullCount: number; windowedCount: number }> {
  const run = async (mode: 'full' | 'window') => {
    if (mode === 'full') seedFullStore(); else seedWindowedStore()
    const { result, unmount } = opts.render()
    await waitFor(() => {
      const have = useAppStore.getState().loadedMonths
      expect(monthsCovering(opts.from, opts.to, 1).every((m) => have.has(m))).toBe(true)
      expect(opts.settled(result.current)).toBe(true)
    })
    await act(async () => { await Promise.resolve() })
    const value = opts.pick(result.current)
    const count = useAppStore.getState().loads.length
    unmount()
    return { value, count }
  }
  const full = await run('full')
  const windowed = await run('window')
  return { full: full.value, windowed: windowed.value, fullCount: full.count, windowedCount: windowed.count }
}
