import { describe, it, expect } from 'vitest'
import {
  disputeCreditInput, disputeCreditNote, disputeRecoveredAmount, matchDisputeDriver,
} from './disputeSettlement'

const dispute = {
  tripNumber: '1117J7TV9',
  shipmentDate: '2026-09-09',
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

describe('disputeCreditNote', () => {
  it('ties the credit to the trip and shipment day', () => {
    expect(disputeCreditNote(dispute)).toBe('Trip 1117J7TV9 · 2026-09-09')
    expect(disputeCreditNote({ tripNumber: 'TRP-1', shipmentDate: null })).toBe('Trip TRP-1')
    expect(disputeCreditNote({ tripNumber: null, shipmentDate: '2026-09-09' })).toBe('Shipment 2026-09-09')
    expect(disputeCreditNote({ tripNumber: '  ', shipmentDate: null })).toBe('Amazon recovery')
  })
})

describe('disputeCreditInput', () => {
  it('writes a 100% DISPUTE credit on the chosen week for the chosen driver', () => {
    expect(disputeCreditInput({
      dispute, driverId: 'd1', periodStart: '2026-09-13', amount: 180.5,
      actorEmail: 'ryne@bcatcorp.com',
    })).toEqual({
      driverId: 'd1',
      periodStart: '2026-09-13',
      kind: 'CREDIT',
      reasonCode: 'DISPUTE',
      label: 'Trip 1117J7TV9 · 2026-09-09',
      amount: 180.5,
      date: '2026-09-09',
      loadRef: '1117J7TV9',
      createdBy: 'ryne@bcatcorp.com',
    })
  })

  it('keeps a legacy free-text shipment date off the credit date column', () => {
    const input = disputeCreditInput({
      dispute: { tripNumber: 'TRP-9', shipmentDate: '4/19 - 4/25' },
      driverId: 'd1', periodStart: '2026-09-13', amount: 50,
    })
    expect(input.date).toBeNull()
    expect(input.createdBy).toBeNull()
  })
})
