import { describe, it, expect } from 'vitest'
import { groupByFleet, fleetSectionOf } from './fleetSections'
import type { DispatchConversation } from '@/lib/dispatch'

const drivers = [
  { id: 'oo', fleetGroup: 'AMAZON' as const, driverType: 'OWNER_OPERATOR' as const, type: 'driver' as const },
  { id: 'box', fleetGroup: 'BOX_TRUCK' as const, driverType: 'COMPANY' as const, type: 'driver' as const },
  { id: 'ivan', fleetGroup: 'LOCAL' as const, driverType: 'COMPANY' as const, type: 'driver' as const },
  { id: 'brk', fleetGroup: null, driverType: null, type: 'broker' as const },
]
const c = (id: string, driverId: string | null, unread = 0, at = '2026-10-10T12:00:00Z'): DispatchConversation => ({ id, phone: `+1847555${id.padStart(4, '0')}`, driverId, unreadCount: unread, lastMessageAt: at })

describe('fleet sections', () => {
  it('files each conversation by its driver’s fleet, brokers and unknown numbers under Other', () => {
    expect(fleetSectionOf(c('1', 'oo'), drivers)).toBe('OWNER_OP')
    expect(fleetSectionOf(c('2', 'box'), drivers)).toBe('BOX_TRUCK')
    expect(fleetSectionOf(c('3', 'ivan'), drivers)).toBe('IVAN')
    expect(fleetSectionOf(c('4', 'brk'), drivers)).toBe('OTHER')
    expect(fleetSectionOf(c('5', null), drivers)).toBe('OTHER')
    expect(fleetSectionOf(c('6', 'gone'), drivers)).toBe('OTHER')
  })
  it('orders sections owner operators, box trucks, Ivan local, other and drops empty ones', () => {
    const g = groupByFleet([c('5', null), c('3', 'ivan'), c('1', 'oo')], drivers)
    expect(g.map((s) => s.key)).toEqual(['OWNER_OP', 'IVAN', 'OTHER'])
    expect(g.map((s) => s.label)).toEqual(['Owner operators', 'Ivan local', 'Other numbers'])
  })
  it('keeps unread rows first inside a section and counts the section’s unread', () => {
    const g = groupByFleet([c('1', 'ivan', 0, '2026-10-10T13:00:00Z'), c('2', 'ivan', 2, '2026-10-10T11:00:00Z')], drivers)
    expect(g[0].rows.map((r) => r.id)).toEqual(['2', '1'])
    expect(g[0].unread).toBe(2)
  })
})
