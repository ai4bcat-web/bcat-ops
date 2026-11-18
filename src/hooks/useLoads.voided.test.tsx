// @vitest-environment jsdom
/**
 * Ryne 2026-11-18: anyone on the team may void a load, and a voided load comes off the calendar.
 * Every calendar, dispatch, schedule and appointment view reads `useLoads`, so this is the one
 * place that has to hold: a load carrying `voidedAt` is never in what it returns, and a void
 * arriving over the live subscription (the load updated in place) takes it out at once.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLoads } from './useLoads'
import { useAppStore } from '@/store/useAppStore'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))

const load = (id: string, extra: Record<string, unknown> = {}) => ({ id, shipmentId: `shp-${id}`, status: 'BOOKED', ...extra }) as never

describe('useLoads and a voided shipment', () => {
  it('leaves voided loads out, and drops a load the moment it is voided in place', () => {
    useAppStore.setState({ loads: [load('a'), load('b', { voidedAt: '2026-11-18T12:00:00.000Z' }), load('c')] })
    const { result } = renderHook(() => useLoads())
    expect(result.current.loads.map((l) => l.id)).toEqual(['a', 'c'])

    act(() => {
      useAppStore.setState((s) => ({ loads: s.loads.map((l) => (l.id === 'c' ? ({ ...l, voidedAt: '2026-11-18T13:00:00.000Z' } as never) : l)) }))
    })
    expect(result.current.loads.map((l) => l.id)).toEqual(['a'])
  })
})
