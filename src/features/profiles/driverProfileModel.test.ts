import { describe, expect, it } from 'vitest'
import {
  basicsErrors, classificationForFleet, currentFixedExpenses, docsSummary, FLEET_OPTIONS, fleetLabel, hourlyRateError, normalizePhone, payError, payLines, requiredDocsFor, settlementLink, wizardPayDefaults,
} from './driverProfileModel'
import type { DriverPaySetting } from '@/lib/apiClient'

const setting = (over: Partial<DriverPaySetting> = {}): DriverPaySetting => ({
  id: 's1', driverId: 'd1', payGroup: 'BOX_TRUCK', payPercent: 0.5, expensesBeforePercent: true,
  email: 'z@x.com', fuelCardNumber: '00049', fixedExpenses: [], createdAt: '', updatedAt: '', ...over,
})

describe('driver profile model', () => {
  it('formats a phone the way the driver editor stores it', () => {
    expect(normalizePhone('3125550100')).toBe('(312) 555-0100')
    expect(normalizePhone('+1 312 555 0100')).toBe('(312) 555-0100')
    expect(normalizePhone('555')).toBe('555')
  })

  it('blocks the Basics step on a missing name, short phone, bad e-mail or no type', () => {
    expect(Object.keys(basicsErrors({ name: '', phone: '12', email: 'nope', fleet: '' }))).toEqual(['name', 'phone', 'email', 'fleet'])
    expect(basicsErrors({ name: 'Zak', phone: '312-555-0100', email: '', fleet: 'BOX_TRUCK' })).toEqual({})
  })

  it('defaults pay by type: box trucks and owner operators 50% after expenses, locals hourly', () => {
    expect(wizardPayDefaults('BOX_TRUCK')).toEqual({ percentPaid: true, percent: '50', afterExpenses: true })
    expect(wizardPayDefaults('OWNER_OPERATOR').afterExpenses).toBe(true)
    expect(wizardPayDefaults('LOCAL').percentPaid).toBe(false)
  })

  it('validates the pay percent only for percent-paid types', () => {
    expect(payError('LOCAL', '')).toBeNull()
    expect(payError('BOX_TRUCK', '')).toMatch(/between 1 and 100/)
    expect(payError('BOX_TRUCK', '101')).toMatch(/between 1 and 100/)
    expect(payError('BOX_TRUCK', '50%')).toBeNull()
  })

  it('summarises documents: missing beats expiring beats complete', () => {
    const slots = requiredDocsFor('LOCAL', true)
    expect(slots.length).toBeGreaterThan(0)
    expect(docsSummary('LOCAL', () => 'MISSING', true)).toMatchObject({ tone: 'red', label: `Missing ${slots.length}` })
    expect(docsSummary('LOCAL', (k) => (k === slots[0]!.key ? 'EXPIRING_SOON' : 'VALID'), true)).toMatchObject({ tone: 'orange', label: 'Expiring 1' })
    expect(docsSummary('LOCAL', () => 'VALID', true)).toMatchObject({ tone: 'green', label: 'Complete' })
  })

  it('reads a stored pay setting into display lines, and shows hourly for a local with none', () => {
    const lines = payLines(setting(), 'BOX_TRUCK')
    expect(lines).toContainEqual({ label: 'Pay percent', value: '50%' })
    expect(lines).toContainEqual({ label: 'Calculation', value: '% of net, after expenses' })
    expect(payLines(undefined, 'LOCAL')).toEqual([{ label: 'Pay model', value: 'Hourly (time card)' }])
    expect(payLines(undefined, 'BOX_TRUCK')).toEqual([])
  })

  it('lists only the fixed expenses in force today', () => {
    const s = setting({
      fixedExpenses: [
        { label: 'Insurance', amount: 100, from: '2026-01-01', until: null },
        { label: 'Old lease', amount: 50, from: '2025-01-01', until: '2026-01-01' },
        { label: 'Ended', amount: 10, from: '2026-01-01', until: null, endedAt: '2026-05-01' },
      ] as never,
    })
    expect(currentFixedExpenses(s, '2026-11-11')).toEqual([{ label: 'Insurance', amount: 100 }])
  })

  it('points each type at the settlement page it already has', () => {
    expect(settlementLink('BOX_TRUCK')?.to).toBe('/driver-pay-box-trucks')
    expect(settlementLink('LOCAL')?.to).toBe('/hours')
    expect(settlementLink(null)).toBeNull()
  })
})

describe('driver types (Ryne 2026-11-11)', () => {
  it('offers Local, Owner operator and Box truck only, and reads an Amazon driver as an owner operator', () => {
    expect(FLEET_OPTIONS.map((o) => o.value)).toEqual(['LOCAL', 'OWNER_OPERATOR', 'BOX_TRUCK'])
    expect(fleetLabel('AMAZON')).toBe('Owner operator')
  })
  it('box truck drivers are employees: their documents are the company set', () => {
    expect(classificationForFleet('BOX_TRUCK')).toBe('COMPANY')
    expect(classificationForFleet('AMAZON')).toBe('OWNER_OPERATOR')
  })
  it('validates the optional dates and a starting hourly rate', () => {
    expect(basicsErrors({ name: 'A', phone: '3125550100', email: '', fleet: 'LOCAL', hireDate: 'nope' }).hireDate).toBeTruthy()
    expect(basicsErrors({ name: 'A', phone: '3125550100', email: '', fleet: 'LOCAL', hireDate: '2026-11-02' }).hireDate).toBeUndefined()
    expect(hourlyRateError('')).toBeNull()
    expect(hourlyRateError('$25.50')).toBeNull()
    expect(hourlyRateError('0')).toBeTruthy()
  })
})
