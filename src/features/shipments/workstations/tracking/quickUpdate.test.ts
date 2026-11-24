import { describe, it, expect } from 'vitest'
import { nowIso, quickTimeRows, statusOptions, timeProblem } from './quickUpdate'
import type { Stop } from '@/types'

const stop = (over: Partial<Stop>): Stop => ({ id: 's', type: 'pickup', sequence: 1, appt: '2026-11-20T14:00:00.000Z', ...over } as Stop)

const load = (stops: Stop[]) => ({ id: 'ld-1', stops })

describe('quickTimeRows', () => {
  it('gives a one-pickup one-delivery load the four times Ryne asked for, in route order', () => {
    const rows = quickTimeRows(load([
      stop({ id: 'pu', type: 'pickup', sequence: 1 }),
      stop({ id: 'de', type: 'delivery', sequence: 2 }),
    ]))
    expect(rows.map((r) => r.label)).toEqual(['On site at pickup', 'Departed pickup', 'Arrived at delivery', 'Delivered'])
    expect(rows.map((r) => `${r.stopId}:${r.kind}`)).toEqual(['pu:arrivedAt', 'pu:departedAt', 'de:arrivedAt', 'de:departedAt'])
  })

  it('numbers extra stops and calls only the last delivery Delivered', () => {
    const rows = quickTimeRows(load([
      stop({ id: 'p1', type: 'pickup', sequence: 1 }),
      stop({ id: 'p2', type: 'pickup', sequence: 2 }),
      stop({ id: 'd1', type: 'delivery', sequence: 3 }),
      stop({ id: 'd2', type: 'delivery', sequence: 4 }),
    ]))
    expect(rows.find((r) => r.key === 'p2:arrivedAt')?.where).toBe('Pickup 2 of 2')
    expect(rows.find((r) => r.key === 'd1:departedAt')?.label).toBe('Departed delivery')
    expect(rows.find((r) => r.key === 'd2:departedAt')?.label).toBe('Delivered')
  })

  it('carries what is saved and the arrival a departure must follow', () => {
    const rows = quickTimeRows(load([
      stop({ id: 'pu', type: 'pickup', sequence: 1, arrivedAt: '2026-11-20T14:05:00.000Z' }),
    ]))
    expect(rows[0].value).toBe('2026-11-20T14:05:00.000Z')
    expect(rows[1].value).toBeNull()
    expect(rows[1].after).toBe('2026-11-20T14:05:00.000Z')
    expect(rows[0].after).toBeNull()
  })

  it('has no rows for a load without stops', () => {
    expect(quickTimeRows(load([]))).toEqual([])
  })
})

describe('timeProblem', () => {
  const now = Date.parse('2026-11-24T15:00:00.000Z')
  it('refuses a future time and a departure before the arrival, allows a few minutes of skew', () => {
    expect(timeProblem({ after: null }, '2026-11-24T16:00:00.000Z', now)).toMatch(/future/)
    expect(timeProblem({ after: null }, '2026-11-24T15:03:00.000Z', now)).toBeNull()
    expect(timeProblem({ after: '2026-11-24T10:00:00.000Z' }, '2026-11-24T09:00:00.000Z', now)).toMatch(/before/)
    expect(timeProblem({ after: '2026-11-24T10:00:00.000Z' }, '2026-11-24T11:00:00.000Z', now)).toBeNull()
    expect(timeProblem({ after: null }, 'nope', now)).toMatch(/Enter/)
  })
})

describe('statusOptions', () => {
  it('offers only what the server lets a person set, never INVOICING', () => {
    const values = statusOptions('DISPATCHED', 'FTL').map((o) => o.value)
    expect(values).toContain('DELIVERED')
    expect(values).not.toContain('INVOICING')
    expect(values).not.toContain('BOOKED')
    expect(statusOptions('DELIVERED', 'FTL').map((o) => o.value)).not.toContain('CANCELED')
    expect(statusOptions('CANCELED', 'FTL')).toEqual([])
  })
})

describe('nowIso', () => {
  it('is the clock as an ISO string', () => {
    expect(nowIso(Date.parse('2026-11-24T15:00:00.000Z'))).toBe('2026-11-24T15:00:00.000Z')
  })
})
