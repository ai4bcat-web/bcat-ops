import { describe, expect, it } from 'vitest'
import { LADDER_FILTER_OPTIONS, assignmentChip, assignmentChipText, dispatchBlock, ladderActions } from './carrierLadder'

const FULL = { driverName: 'Dee', driverPhone: '555', truckNumber: 'T1', trailerNumber: 'R1' }

describe('assignmentChip', () => {
  it('shows nothing when nobody is assigned', () => {
    expect(assignmentChip(null, 'OPEN')).toBeNull()
    expect(assignmentChipText({ carrierAssignmentStatus: undefined, status: 'OPEN' })).toBe('')
  })

  it('labels each rung with the wording Ryne asked for', () => {
    expect(LADDER_FILTER_OPTIONS.map((o) => o.label)).toEqual([
      'Carrier assigned - waiting for carrier setup',
      'Carrier setup complete',
      'Rate con sent',
      'Rate con signed',
      'Driver info entered',
    ])
  })

  it('hands the display to the shipment status once driver info is in and the shipment is moving', () => {
    expect(assignmentChip('DRIVER_INFO_ENTERED', 'BOOKED')).toMatchObject({ label: 'Driver info entered', shipmentOwns: false })
    const moving = assignmentChip('DRIVER_INFO_ENTERED', 'IN_TRANSIT', 'In transit')
    expect(moving).toMatchObject({ label: 'In transit', shipmentOwns: true })
  })

  it('never lets the shipment status override an earlier rung', () => {
    // A load can be dispatched on legacy data without the ladder being complete; the ladder is the honest answer.
    expect(assignmentChip('RATE_CON_SENT', 'DISPATCHED')?.label).toBe('Rate con sent')
  })
})

describe('ladderActions', () => {
  it('offers the setup packet, not the rate con, while MyCarrierPackets has not confirmed setup', () => {
    const out = ladderActions({ ladder: 'ASSIGNED_SETUP_PENDING', carrierActive: false, rateConStatus: null, driver: {} })
    expect(out.map((a) => a.key)).toEqual(['SEND_SETUP_PACKET', 'SEND_RATE_CON', 'MARK_SIGNED', 'ENTER_DRIVER_INFO'])
    expect(out.find((a) => a.key === 'SEND_SETUP_PACKET')?.blockedBy).toBeNull()
    for (const key of ['SEND_RATE_CON', 'MARK_SIGNED', 'ENTER_DRIVER_INFO']) {
      expect(out.find((a) => a.key === key)?.blockedBy).toMatch(/MyCarrierPackets/)
    }
  })

  it('once set up: send the rate con; signing needs it sent first; no packet button', () => {
    const out = ladderActions({ ladder: 'ASSIGNED_SETUP_COMPLETE', carrierActive: true, rateConStatus: 'NOT_SENT', driver: {} })
    expect(out.map((a) => a.key)).not.toContain('SEND_SETUP_PACKET')
    expect(out.find((a) => a.key === 'SEND_RATE_CON')).toMatchObject({ label: 'Send rate con', blockedBy: null })
    expect(out.find((a) => a.key === 'MARK_SIGNED')?.blockedBy).toBe('Send the rate con first')
  })

  it('after the send: Resend and Mark signed are both live', () => {
    const out = ladderActions({ ladder: 'RATE_CON_SENT', carrierActive: true, rateConStatus: 'OPENED', driver: {} })
    expect(out.find((a) => a.key === 'SEND_RATE_CON')?.label).toBe('Resend rate con')
    expect(out.find((a) => a.key === 'MARK_SIGNED')?.blockedBy).toBeNull()
  })

  it('once signed there is nothing left to send or sign, only the driver', () => {
    const out = ladderActions({ ladder: 'RATE_CON_SIGNED', carrierActive: true, rateConStatus: 'SIGNED', driver: {} })
    expect(out.map((a) => a.key)).toEqual(['ENTER_DRIVER_INFO'])
  })

  it('a finished ladder offers no steps', () => {
    expect(ladderActions({ ladder: 'DRIVER_INFO_ENTERED', carrierActive: true, rateConStatus: 'SIGNED', driver: FULL })).toEqual([])
    expect(ladderActions({ ladder: null, carrierActive: true, driver: FULL })).toEqual([])
  })
})

describe('dispatchBlock', () => {
  it('names every missing driver field', () => {
    expect(dispatchBlock({ driverName: 'Dee', driverPhone: ' ', truckNumber: null })).toBe(
      'Driver info is required before dispatch: driver phone, truck number, trailer number',
    )
  })

  it('lets a fully entered driver through', () => {
    expect(dispatchBlock(FULL)).toBeNull()
  })
})
