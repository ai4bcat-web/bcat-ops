import { describe, expect, it } from 'vitest'
import { isOwnerOperatorGroup, ownerOpCarriesWeeklyCharges, OWNER_OP_FIRST_PERIOD } from './ownerOperatorTrips'
import { AMAZON_OVERLAP_NOTE, onAmazonStatement, onOwnerOperatorStatement, payGroupForWeek, resolveWeekSettlement } from './driverPay'

describe('owner operator changeover', () => {
  it('counts an Amazon-group driver and an owner-operator-group driver as owner operators', () => {
    expect(isOwnerOperatorGroup('AMAZON')).toBe(true)
    expect(isOwnerOperatorGroup('OWNER_OPERATOR')).toBe(true)
    expect(isOwnerOperatorGroup(null)).toBe(true)
    expect(isOwnerOperatorGroup('BOX_TRUCK')).toBe(false)
  })
  it('weekly charges move to the owner-operator statement from 2026-09-27, never before', () => {
    expect(OWNER_OP_FIRST_PERIOD).toBe('2026-09-27')
    expect(ownerOpCarriesWeeklyCharges('2026-09-20')).toBe(false)
    expect(ownerOpCarriesWeeklyCharges('2026-09-27')).toBe(true)
  })
})


describe('who settles as an owner operator from the changeover (Amazon stopped 2026-09-27)', () => {
  const amazon = { payGroup: 'AMAZON', rateHistory: null }
  const oo = { payGroup: 'OWNER_OPERATOR', rateHistory: null }
  const pin = (mode: 'AMAZON' | 'OWNER_OPERATOR', from: string, until: string) => ({
    payGroup: 'AMAZON', rateHistory: [{ from, until, payPercent: 0.5, expensesBeforePercent: false, payGroup: mode }],
  })

  it('weeks before 2026-09-27 are untouched: the pay group decides, exactly as payGroupForWeek says', () => {
    for (const week of ['2026-05-31', '2026-09-13', '2026-09-20']) {
      expect(resolveWeekSettlement(amazon, week, true)).toEqual({ group: payGroupForWeek(amazon, week), overlap: false })
      expect(resolveWeekSettlement(amazon, week, false).group).toBe('AMAZON')
      expect(resolveWeekSettlement(oo, week, false).group).toBe('OWNER_OPERATOR')
    }
  })

  it('from 2026-09-27 an unpinned Amazon-group or owner-operator driver defaults to standard owner operator', () => {
    for (const week of ['2026-09-27', '2026-10-04', '2026-11-08']) {
      expect(resolveWeekSettlement(amazon, week, false)).toEqual({ group: 'OWNER_OPERATOR', overlap: false })
      expect(resolveWeekSettlement(oo, week, false)).toEqual({ group: 'OWNER_OPERATOR', overlap: false })
      expect(resolveWeekSettlement({ payGroup: null }, week, false).group).toBe('OWNER_OPERATOR')
      expect(onAmazonStatement(amazon, week, false)).toBe(false)
      expect(onOwnerOperatorStatement(amazon, week)).toBe(true)
    }
  })

  it('an overlap week (Amazon trips still exist) stays on the Amazon side and is flagged, and the owner-operator statement still lists the driver', () => {
    expect(resolveWeekSettlement(amazon, '2026-09-27', true)).toEqual({ group: 'AMAZON', overlap: true })
    expect(onAmazonStatement(amazon, '2026-10-04', true)).toBe(true)
    expect(onOwnerOperatorStatement(amazon, '2026-10-04')).toBe(true)
    expect(AMAZON_OVERLAP_NOTE).toBe('Amazon trips this week: confirm pay mode')
    // a driver already in the owner-operator group is never an overlap: Amazon trips for them are not expected here
    expect(resolveWeekSettlement(oo, '2026-10-04', true)).toEqual({ group: 'OWNER_OPERATOR', overlap: false })
  })

  it('a pin always wins, in both directions and on both sides of the date, and clears the flag', () => {
    expect(resolveWeekSettlement(pin('AMAZON', '2026-10-04', '2026-10-11'), '2026-10-04', false)).toEqual({ group: 'AMAZON', overlap: false })
    expect(resolveWeekSettlement(pin('OWNER_OPERATOR', '2026-10-04', '2026-10-11'), '2026-10-04', true)).toEqual({ group: 'OWNER_OPERATOR', overlap: false })
    expect(onAmazonStatement(pin('OWNER_OPERATOR', '2026-10-04', '2026-10-11'), '2026-10-04', true)).toBe(false)
    // an unpinned neighbour is unaffected
    expect(resolveWeekSettlement(pin('AMAZON', '2026-10-04', '2026-10-11'), '2026-10-11', false).group).toBe('OWNER_OPERATOR')
    // a pin before the changeover wins too
    expect(resolveWeekSettlement(pin('OWNER_OPERATOR', '2026-09-13', '2026-09-20'), '2026-09-13', false).group).toBe('OWNER_OPERATOR')
  })

  it('other pay groups are never moved', () => {
    expect(resolveWeekSettlement({ payGroup: 'BOX_TRUCK' }, '2026-10-04', true)).toEqual({ group: 'BOX_TRUCK', overlap: false })
  })
})
