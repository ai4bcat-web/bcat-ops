import { describe, it, expect } from 'vitest'
import { withOwnerOpFrom, withOwnerOpTo, ownerOpServiceDays, onOwnerOperatorStatement, explicitWeekMode, payModeHistory, clearWeekPayMode, hasOwnerOpService } from './driverPay'
import { ownerOperatorChange } from './ownerOperatorChange'
import { ownerOpBeforeEnd } from './ownerOperatorTrips'

const base = { payPercent: 0.88, expensesBeforePercent: false }

describe('owner operator effective dates', () => {
  it('marks every week before the week holding the start day as not owner operator, and keeps that week', () => {
    // 2026-10-08 is a Thursday: the pay week is 10/4–10/10.
    const history = withOwnerOpFrom(null, '2026-10-08', base)
    const s = { payGroup: 'OWNER_OPERATOR', rateHistory: history }
    expect(ownerOpServiceDays(s)).toEqual({ from: '2026-10-08', to: null })
    expect(onOwnerOperatorStatement(s, '2026-09-27')).toBe(false)
    expect(onOwnerOperatorStatement(s, '2026-10-04')).toBe(true)
    expect(onOwnerOperatorStatement(s, '2026-10-11')).toBe(true)
  })

  it('lists a driver whose setting still carries another pay group once they have a start day', () => {
    const s = { payGroup: 'LOCAL', rateHistory: withOwnerOpFrom(null, '2026-10-08', base) }
    expect(hasOwnerOpService(s)).toBe(true)
    expect(onOwnerOperatorStatement(s, '2026-10-04')).toBe(true)
    expect(onOwnerOperatorStatement({ payGroup: 'LOCAL', rateHistory: null }, '2026-10-04')).toBe(false)
  })

  it('stops listing weeks after the last day, and keeps the week holding it', () => {
    const history = withOwnerOpTo(withOwnerOpFrom(null, '2026-10-08', base), '2026-11-12', base)
    const s = { payGroup: 'OWNER_OPERATOR', rateHistory: history }
    expect(ownerOpServiceDays(s)).toEqual({ from: '2026-10-08', to: '2026-11-12' })
    expect(onOwnerOperatorStatement(s, '2026-11-08')).toBe(true) // 11/8–11/14 holds 11/12
    expect(onOwnerOperatorStatement(s, '2026-11-15')).toBe(false)
    expect(ownerOpBeforeEnd('2026-11-12', '2026-11-08')).toBe(true)
    expect(ownerOpBeforeEnd('2026-11-12', '2026-11-15')).toBe(false)
  })

  it('changing the date replaces the old marker instead of stacking another', () => {
    const once = withOwnerOpFrom(null, '2026-10-08', base)
    const twice = withOwnerOpFrom(once, '2026-10-22', base)
    expect(twice.filter((w) => w.ownerOpFrom)).toHaveLength(1)
    expect(ownerOpServiceDays({ rateHistory: twice }).from).toBe('2026-10-22')
  })

  it('does not disturb pinned week modes, and the markers never show as a pinned mode', () => {
    const pinned = [{ from: '2026-10-11', until: '2026-10-18', payPercent: 0.5, expensesBeforePercent: true, payGroup: 'AMAZON' as const }]
    const history = withOwnerOpFrom(pinned, '2026-10-08', base)
    expect(history).toContainEqual(pinned[0])
    expect(explicitWeekMode({ rateHistory: history }, '2026-09-27')).toBeNull()
    expect(payModeHistory({ rateHistory: history }).map((w) => w.mode)).toEqual(['AMAZON'])
    // Clearing a week's mode leaves the markers alone.
    expect(clearWeekPayMode(history, '2026-09-27', base)).toEqual(history)
  })
})

describe('which fleet changes ask for a date', () => {
  it('asks on a switch to owner operator, and on a switch away', () => {
    expect(ownerOperatorChange('LOCAL', 'OWNER_OPERATOR')).toBe('START')
    expect(ownerOperatorChange(null, 'AMAZON')).toBe('START')
    expect(ownerOperatorChange('OWNER_OPERATOR', 'LOCAL')).toBe('END')
  })
  it('does not ask when nothing changes between owner operator and company', () => {
    expect(ownerOperatorChange('LOCAL', 'BOX_TRUCK')).toBeNull()
    expect(ownerOperatorChange('OWNER_OPERATOR', 'AMAZON')).toBeNull()
    expect(ownerOperatorChange(null, null)).toBeNull()
  })
})
