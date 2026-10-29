// @vitest-environment jsdom
/**
 * The Load table has two readings, and a voided load is the case that tells them apart.
 *
 * A voided shipment leaves every working set — it is not dispatchable, billable or
 * countable work — but it never gives its Pro # back: that number is permanent, and the
 * duplicate-Pro check is the only thing standing between a voided load and a second load
 * reusing its number. So `useLoads().loads` must hide it and `useLoads().allLoads` must
 * still hold it. These tests pin both halves against the one record that matters.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { proConflict } from '@/lib/proConflict'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from './useLoads'
import type { Load } from '@/types'

const load = (over: Partial<Load>): Load => ({
  id: 'l1', aljexId: '14578', stops: [], readyToInvoice: false, ...over,
} as Load)

const LIVE = load({ id: 'live', aljexId: '20001' })
const VOIDED = load({ id: 'voided', aljexId: '14578', voidedAt: '2026-10-01T12:00:00.000Z' })

beforeEach(() => {
  useAppStore.setState({ loads: [LIVE, VOIDED] })
})

describe('useLoads — working set vs identity table', () => {
  it('keeps the voided load out of the live working set', () => {
    const { loads } = renderHook(() => useLoads()).result.current
    expect(loads.map((l) => l.id)).toEqual(['live'])
  })

  it('still carries the voided load on the identity table', () => {
    const { allLoads } = renderHook(() => useLoads()).result.current
    expect(allLoads.map((l) => l.id)).toEqual(['live', 'voided'])
  })

  it('blocks a new load from reusing a voided load Pro #', () => {
    // What LoadDrawer does on save: the identity table is what it asks.
    const { allLoads } = renderHook(() => useLoads()).result.current
    expect(proConflict(allLoads, '14578', null)).toMatchObject({
      kind: 'block',
      other: { id: 'voided' },
    })
  })

  it('would have let the Pro # be reissued off the working set — which is why it is not used there', () => {
    const { loads } = renderHook(() => useLoads()).result.current
    expect(proConflict(loads, '14578', null)).toEqual({ kind: 'none' })
  })

  it('hands back the same working-set array while the store array is unchanged', () => {
    // The filter has to be memoised: a fresh array per render would spin
    // useSyncExternalStore, which is why it lives in a memo and not in the selector.
    const { result, rerender } = renderHook(() => useLoads())
    const first = result.current.loads
    rerender()
    expect(result.current.loads).toBe(first)
  })
})
