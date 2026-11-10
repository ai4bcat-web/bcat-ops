// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const rows = vi.hoisted(() => ({ working: [] as unknown[], windowed: [] as unknown[] }))
vi.mock('@/hooks/useShipments', () => ({
  useShipments: (view: { kind: string }) => ({ shipments: view.kind === 'working' ? rows.working : rows.windowed }),
}))

import { useLoadReviewMarks } from './useLoadReviewMarks'

const load = (id: string, shipmentId: string | null, over: Record<string, unknown> = {}) =>
  ({ id, shipmentId, pickupAppt: '2026-11-09T13:00:00.000Z', readyToInvoice: false, ...over }) as never

describe('useLoadReviewMarks', () => {
  it('marks green the loads of shipments in Load Review (pushed), and leaves the rest unmarked', () => {
    rows.working = [{ id: 's1', loadReviewPushedAt: '2026-11-10T10:00:00.000Z' }, { id: 's2' }]
    rows.windowed = []
    const { result } = renderHook(() => useLoadReviewMarks([load('l1', 's1'), load('l2', 's2')]))
    expect(result.current.map((l) => l.readyToInvoice)).toEqual([true, false])
  })

  it('keeps a released shipment green, and one that left the working set when its status says invoicing', () => {
    rows.working = [{ id: 's3', readyToInvoiceAt: '2026-11-10T10:00:00.000Z' }]
    rows.windowed = []
    const { result } = renderHook(() => useLoadReviewMarks([load('l3', 's3'), load('l4', 'gone', { status: 'INVOICING' })]))
    expect(result.current.map((l) => l.readyToInvoice)).toEqual([true, true])
  })

  it('ignores the old stored ready-to-invoice flag', () => {
    rows.working = [{ id: 's5' }]
    rows.windowed = []
    const { result } = renderHook(() => useLoadReviewMarks([load('l5', 's5', { readyToInvoice: true })]))
    expect(result.current[0]!.readyToInvoice).toBe(false)
  })

  it('takes brokerage shipments off the calendar entirely, whether or not they need a carrier', () => {
    rows.working = [{ id: 'b1', revDivision: 'BROKERAGE' }, { id: 'a1', revDivision: 'ASSETS' }]
    rows.windowed = [{ id: 'b2', revDivision: 'BROKERAGE' }]
    const { result } = renderHook(() => useLoadReviewMarks([load('l6', 'b1'), load('l7', 'a1'), load('l8', 'b2'), load('l9', null)]))
    expect(result.current.map((l) => l.id)).toEqual(['l7', 'l9'])
  })
})
