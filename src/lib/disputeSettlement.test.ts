import { describe, it, expect } from 'vitest'
import {
  disputeRecoveredAmount, disputeTripInput, disputeTripLabel, matchDisputeDriver,
} from './disputeSettlement'

const dispute = {
  tripNumber: '1117J7TV9',
  shipmentDate: '2026-09-09',
  payPeriod: '2026-09-06',
  resolvedAmount: 180.5,
  amountRequested: 250,
}

describe('matchDisputeDriver', () => {
  const drivers = [
    { id: 'd1', name: 'Chad Salerno', active: true },
    { id: 'd2', name: 'Jason Smith', active: true },
  ]

  it('matches a typed portal name regardless of case and spacing', () => {
    expect(matchDisputeDriver('  chad   salerno ', drivers)?.id).toBe('d1')
  })

  it('prefers the active driver when a retired namesake exists', () => {
    const withRetired = [...drivers, { id: 'old', name: 'Chad Salerno', active: false }]
    expect(matchDisputeDriver('Chad Salerno', withRetired)?.id).toBe('d1')
  })

  it('refuses to guess on an unknown name, a blank name, or two active namesakes', () => {
    expect(matchDisputeDriver('Chad', drivers)).toBeNull()
    expect(matchDisputeDriver('   ', drivers)).toBeNull()
    expect(matchDisputeDriver('Chad Salerno', [
      { id: 'a', name: 'Chad Salerno', active: true },
      { id: 'b', name: 'chad salerno', active: true },
    ])).toBeNull()
  })
})

describe('disputeRecoveredAmount', () => {
  it('pays what Amazon actually sent, not what was asked', () => {
    expect(disputeRecoveredAmount(dispute)).toBe(180.5)
  })

  it('falls back to the requested amount when no recovery was keyed', () => {
    expect(disputeRecoveredAmount({ resolvedAmount: null, amountRequested: 250 })).toBe(250)
  })

  it('treats zero, negative and missing figures as nothing to pay', () => {
    expect(disputeRecoveredAmount({ resolvedAmount: 0, amountRequested: 0 })).toBeNull()
    expect(disputeRecoveredAmount({ resolvedAmount: -5, amountRequested: null })).toBeNull()
    expect(disputeRecoveredAmount({ resolvedAmount: null, amountRequested: null })).toBeNull()
  })
})

describe('disputeTripLabel', () => {
  it('labels the row DISPUTE with the shipment date', () => {
    expect(disputeTripLabel(dispute)).toBe('DISPUTE 2026-09-09')
  })

  it('falls back to the disputed pay period, then to a bare label', () => {
    expect(disputeTripLabel({ shipmentDate: '  ', payPeriod: '4/19 - 4/25' })).toBe('DISPUTE 4/19 - 4/25')
    expect(disputeTripLabel({ shipmentDate: null, payPeriod: null })).toBe('DISPUTE')
  })
})

describe('disputeTripInput', () => {
  it('books the recovery as a completed shipment on the chosen week, so it runs through the split', () => {
    expect(disputeTripInput({ dispute, driverId: 'd1', periodStart: '2026-09-13', amount: 180.5 })).toEqual({
      driverId: 'd1',
      periodStart: '2026-09-13',
      loadId: 'DISPUTE 2026-09-09',
      origin: null,
      destination: null,
      miles: null,
      equipment: null,
      freightAmount: 180.5,
      ratePerMile: null,
      dispatcher: null,
      status: 'Completed',
      notes: 'Amazon dispute — Trip 1117J7TV9',
    })
  })

  it('still books a recovery with no trip number', () => {
    const input = disputeTripInput({
      dispute: { tripNumber: null, shipmentDate: '2026-09-09', payPeriod: null },
      driverId: 'd1', periodStart: '2026-09-13', amount: 50,
    })
    expect(input.notes).toBe('Amazon dispute')
    expect(input.freightAmount).toBe(50)
  })
})
