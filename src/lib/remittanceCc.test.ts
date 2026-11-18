import { describe, it, expect } from 'vitest'
import { DEFAULT_REMITTANCE_CC, normalizeCcList, remittanceCcFor } from './remittanceCc'

describe('remittanceCcFor', () => {
  it('copies billing@bcatcorp.com when nobody has ever saved a list', () => {
    expect(DEFAULT_REMITTANCE_CC).toEqual(['billing@bcatcorp.com'])
    expect(remittanceCcFor(undefined, ['ap@carrier.test'])).toEqual(['billing@bcatcorp.com'])
    expect(remittanceCcFor(null, ['ap@carrier.test'])).toEqual(['billing@bcatcorp.com'])
  })

  it('uses the saved list, and a saved empty list copies nobody', () => {
    expect(remittanceCcFor(['ar@bcatcorp.com', 'Owner@BCATcorp.com'], ['ap@carrier.test'])).toEqual(['ar@bcatcorp.com', 'owner@bcatcorp.com'])
    expect(remittanceCcFor([], ['ap@carrier.test'])).toEqual([])
  })

  it('never copies someone who is already on the To line, and never repeats an address', () => {
    expect(remittanceCcFor(undefined, ['Billing@bcatcorp.com'])).toEqual([])
    expect(remittanceCcFor(['a@x.test', 'A@x.test', 'b@x.test'], ['b@x.test'])).toEqual(['a@x.test'])
  })

  it('drops blanks and anything that is not an e-mail address', () => {
    expect(normalizeCcList(['', '  ', 'nope', 'ok@x.test'])).toEqual(['ok@x.test'])
  })
})
