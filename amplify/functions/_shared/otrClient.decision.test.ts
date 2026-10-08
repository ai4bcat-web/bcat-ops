import { describe, it, expect } from 'vitest'
import { decisionFrom, normalizeDecision } from './otrClient'

describe('decisionFrom — the verdict wherever OTR put it', () => {
  it('reads the v2 structured reply (the one production actually sends)', () => {
    const raw = { id: '4525', Name: 'Fox Transportation Services (IL)', McNumber: '592002', BrokerTestResult: 'Approved', NoBuy: false, ResponseStatus: 200 }
    expect(decisionFrom(raw, '')).toBe('APPROVED')
  })

  it('a NoBuy broker is not approved, whatever the test result says', () => {
    expect(decisionFrom({ BrokerTestResult: 'Approved', NoBuy: true }, '')).toBe('NOT APPROVED')
  })

  it('still reads the v1 message when that is all there is', () => {
    expect(decisionFrom({ message: 'Broker NOT APPROVED' }, 'Broker NOT APPROVED')).toBe('NOT APPROVED')
    expect(decisionFrom('plain text', 'Call office')).toBe('CALL OFFICE')
  })

  it('is UNKNOWN only when nothing says anything', () => {
    expect(decisionFrom({ id: '1' }, '')).toBe('UNKNOWN')
    expect(normalizeDecision('')).toBe('UNKNOWN')
  })
})
