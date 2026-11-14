import { describe, expect, it } from 'vitest'
import { driverInitials, driverSettlementHref, ownFleetCoverKind, ownFleetCoverTitle, pingAgeText } from './ownFleetCoverage'

describe('ownFleetCoverKind', () => {
  it('reads the driver fleet group first', () => {
    expect(ownFleetCoverKind({ fleetGroup: 'OWNER_OPERATOR' })).toBe('OWNER_OPERATOR')
    expect(ownFleetCoverKind({ fleetGroup: 'AMAZON' })).toBe('OWNER_OPERATOR')
    expect(ownFleetCoverKind({ fleetGroup: 'LOCAL' }, 'OWNER_OPERATOR')).toBe('LOCAL')
    expect(ownFleetCoverKind({ fleetGroup: 'BOX_TRUCK' })).toBe('BOX_TRUCK')
  })

  it('falls back to driverType when the fleet is empty (Chad: COMPANY on an OO fleet stays OO)', () => {
    expect(ownFleetCoverKind({ fleetGroup: 'OWNER_OPERATOR', driverType: 'COMPANY' })).toBe('OWNER_OPERATOR')
    expect(ownFleetCoverKind({ fleetGroup: null, driverType: 'OWNER_OPERATOR' })).toBe('OWNER_OPERATOR')
    expect(ownFleetCoverKind({ fleetGroup: null, driverType: 'COMPANY' })).toBe('LOCAL')
  })

  it('falls back to the revenue division when the driver says nothing or is not picked', () => {
    expect(ownFleetCoverKind({}, 'OWNER_OPERATOR')).toBe('OWNER_OPERATOR')
    expect(ownFleetCoverKind(null, 'BOX_TRUCK')).toBe('BOX_TRUCK')
    expect(ownFleetCoverKind(undefined, 'local')).toBe('LOCAL')
    expect(ownFleetCoverKind(null, 'ASSETS')).toBeNull()
    expect(ownFleetCoverKind(null, '')).toBeNull()
  })
})

describe('ownFleetCoverTitle', () => {
  it('names the group, or just Ivan Cartage', () => {
    expect(ownFleetCoverTitle('OWNER_OPERATOR')).toBe('Covered by Ivan Cartage · Owner Operator')
    expect(ownFleetCoverTitle('LOCAL')).toBe('Covered by Ivan Cartage · Local Driver')
    expect(ownFleetCoverTitle(null)).toBe('Covered by Ivan Cartage')
  })
})

describe('small formatters', () => {
  it('initials', () => {
    expect(driverInitials('Chad Salerno')).toBe('CS')
    expect(driverInitials('  lee  de la  lara ')).toBe('LL')
    expect(driverInitials('Roy')).toBe('R')
    expect(driverInitials('')).toBe('')
  })
  it('ping age', () => {
    expect(pingAgeText(14)).toBe('14 min ago')
    expect(pingAgeText(180)).toBe('3 h ago')
    expect(pingAgeText(3 * 24 * 60)).toBe('3 d ago')
    expect(pingAgeText(null)).toBeNull()
  })
})

describe('driverSettlementHref', () => {
  it('opens the Sun–Sat week of the delivery appointment for that driver', () => {
    // Sat Nov 14 2026 → week of Sun Nov 8.
    expect(driverSettlementHref('drv-1', '2026-11-14T13:00:00.000Z')).toBe('/owner-operator-pay?week=2026-11-08&driver=drv-1')
    expect(driverSettlementHref('drv-1', '2026-11-08T13:00:00.000Z')).toBe('/owner-operator-pay?week=2026-11-08&driver=drv-1')
  })
  it('is null without a driver or a date', () => {
    expect(driverSettlementHref('', '2026-11-14T13:00:00.000Z')).toBeNull()
    expect(driverSettlementHref('drv-1', null)).toBeNull()
  })
})
