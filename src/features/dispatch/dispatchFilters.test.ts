import { describe, it, expect } from 'vitest'
import { applyFilters, readFilters, writeFilters, filterCount, ALL_FILTERS } from './dispatchFilters'
import type { DispatchConversation } from '@/lib/dispatch'

const drivers = [
  { id: 'ivan', fleetGroup: 'LOCAL' as const, driverType: 'COMPANY' as const, type: 'driver' as const },
  { id: 'oo', fleetGroup: 'AMAZON' as const, driverType: 'OWNER_OPERATOR' as const, type: 'driver' as const },
]
const rows: DispatchConversation[] = [
  { id: '1', phone: '+18475550100', driverId: 'ivan', driverName: 'Jason Smith' },
  { id: '2', phone: '+18475550101', driverId: 'oo', driverName: 'Roy Workman' },
  { id: '3', phone: '+18475550102' },
]

describe('dispatch filters', () => {
  it('shows everything by default', () => {
    expect(applyFilters(rows, drivers, ALL_FILTERS).map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(filterCount(ALL_FILTERS)).toBe(0)
  })
  it('filters by driver type and by name', () => {
    expect(applyFilters(rows, drivers, { types: ['IVAN'], hiddenNames: [] }).map((r) => r.id)).toEqual(['1'])
    expect(applyFilters(rows, drivers, { types: ['IVAN', 'OWNER_OP', 'BOX_TRUCK', 'OTHER'], hiddenNames: ['roy workman'] }).map((r) => r.id)).toEqual(['1', '3'])
    expect(filterCount({ types: ['IVAN'], hiddenNames: ['x'] })).toBe(4)
  })
  it('keeps each person’s own choice, and clears the key when back to all', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
    writeFilters('jenny@bcatcorp.com', { types: ['IVAN'], hiddenNames: ['Roy Workman'] }, storage)
    expect(readFilters('jenny@bcatcorp.com', storage)).toEqual({ types: ['IVAN'], hiddenNames: ['Roy Workman'] })
    expect(readFilters('ryne@bcatcorp.com', storage)).toEqual(ALL_FILTERS)
    writeFilters('jenny@bcatcorp.com', ALL_FILTERS, storage)
    expect(store.size).toBe(0)
    store.set('bcat.dispatch.filters.x@y.com', '{bad json')
    expect(readFilters('x@y.com', storage)).toEqual(ALL_FILTERS)
  })
})
