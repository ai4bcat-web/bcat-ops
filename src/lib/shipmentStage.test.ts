import { describe, expect, it } from 'vitest'
import { notCreatedStage, shipmentStage, STAGE_LADDER, type StageInput } from './shipmentStage'

const row = (over: Partial<StageInput> = {}): StageInput => ({ status: 'OPEN', ...over })
const stageOf = (over: Partial<StageInput>) => shipmentStage(row(over)).stage

describe('shipmentStage', () => {
  it('create mode is Draft, not created yet, with the stepper at the first rung', () => {
    expect(notCreatedStage()).toMatchObject({ stage: 'DRAFT', label: 'Draft, not created yet', step: 0, notCreated: true, terminal: false })
  })

  it('maps movement through the board vocabulary', () => {
    expect(stageOf({ status: 'DRAFT' })).toBe('DRAFT')
    expect(stageOf({ status: 'OPEN' })).toBe('ACTIVE')
    expect(stageOf({ status: 'TENDER_PENDING' })).toBe('ACTIVE')
    expect(stageOf({ status: 'ON_HOLD' })).toBe('ACTIVE')
    expect(stageOf({ status: 'BOOKED' })).toBe('ACTIVE')
    expect(stageOf({ status: 'BOOKED', assignmentType: 'CARRIER' })).toBe('COVERED')
    expect(stageOf({ status: 'PLANNED', assignmentType: 'OWN_ASSET' })).toBe('COVERED')
    for (const status of ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED', 'OUT_FOR_DELIVERY', 'UNLOADING'] as const) {
      expect(stageOf({ status })).toBe('IN_TRANSIT')
    }
    expect(stageOf({ status: 'DELIVERED' })).toBe('DELIVERED')
  })

  it('a DRAFT that came from an intake item is in Intake review until it is reviewed', () => {
    expect(stageOf({ status: 'DRAFT', intakeLoadId: 'in-1' })).toBe('INTAKE_REVIEW')
    expect(stageOf({ status: 'DRAFT', intakeLoadId: 'in-1', intakeReviewedAt: '2026-11-01T00:00:00Z' })).toBe('DRAFT')
  })

  it('a pushed or released shipment is in Load Review until invoiced, then Billed, then Paid', () => {
    expect(stageOf({ status: 'DELIVERED', loadReviewPushedAt: '2026-11-01T00:00:00Z' })).toBe('LOAD_REVIEW')
    expect(stageOf({ status: 'DELIVERED', arStatus: 'UNBILLED', readyToInvoiceAt: '2026-11-01T00:00:00Z' })).toBe('LOAD_REVIEW')
    expect(stageOf({ status: 'DELIVERED', arStatus: 'UNPAID', invoiceId: 'inv-1' })).toBe('BILLED')
    expect(stageOf({ status: 'DELIVERED', arStatus: 'PAID', invoiceId: 'inv-1' })).toBe('PAID')
  })

  it('voided wins over everything and is a red terminal off the ladder; a plain cancel is terminal too', () => {
    const voided = shipmentStage(row({ status: 'DELIVERED', voidedAt: '2026-11-01T00:00:00Z', arStatus: 'PAID' }))
    expect(voided).toMatchObject({ stage: 'VOIDED', label: 'Voided', step: -1, terminal: true })
    expect(shipmentStage(row({ status: 'CANCELED' }))).toMatchObject({ stage: 'CANCELED', terminal: true })
  })

  it('every rung of the ladder is reachable', () => {
    const reached = new Set([
      stageOf({ status: 'DRAFT' }), stageOf({ status: 'DRAFT', intakeLoadId: 'i' }), stageOf({ status: 'OPEN' }),
      stageOf({ status: 'BOOKED', assignmentType: 'CARRIER' }), stageOf({ status: 'IN_TRANSIT' }), stageOf({ status: 'DELIVERED' }),
      stageOf({ loadReviewPushedAt: 'x' }), stageOf({ arStatus: 'UNPAID' }), stageOf({ arStatus: 'PAID' }),
    ])
    expect([...reached].sort()).toEqual([...STAGE_LADDER].sort())
  })
})
