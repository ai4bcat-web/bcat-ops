/**
 * Two rules worth pinning: the parser outranks the model, and a run links a customer
 * record only on an exact address match. The third is structural — a proposal never
 * carries a PRO, because a PRO is issued by the claim, not guessed from an e-mail.
 */
import { describe, it, expect } from 'vitest'
import { proposalToPrefill, tenderFromParse } from './tenderProposal'
import type { TenderPrefill } from '../intakeTender'
import type { WorkflowRunRecord } from '../../types/tms'

const PARSED: TenderPrefill = {
  format: 'E2OPEN',
  reference: 'TMS ID 208663813',
  customer: 'BATORY FOODS',
  stops: [
    { type: 'pickup', name: "BATORY'S OAKLEY CHICAGO", city: 'CHICAGO', state: 'IL' },
    { type: 'delivery', city: 'DANVILLE' },
  ],
}

function run(over: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'wf:TENDER:abc',
    agent: 'TENDER',
    status: 'COMPLETED',
    outcome: 'PROPOSED',
    sourceId: 'intake-1',
    proposalKind: 'TENDER',
    proposal: { kind: 'TENDER', tender: PARSED },
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    ...over,
  }
}

describe('tenderFromParse', () => {
  it('fills blanks and never overwrites what the parser read', () => {
    const out = tenderFromParse(PARSED, {
      customer: 'SOME OTHER BROKER',
      reference: 'GUESSED-1',
      pickupNumber: 'SO-1732669',
      weightLb: 42952,
      stops: [{ city: 'ELGIN', zip: '60609' }, { state: 'IL' }],
    })

    expect(out.reference).toBe('TMS ID 208663813')
    expect(out.customer).toBe('BATORY FOODS')
    expect(out.pickupNumber).toBe('SO-1732669')
    expect(out.weightLb).toBe(42952)
    expect(out.stops[0].city).toBe('CHICAGO')
    expect(out.stops[0].zip).toBe('60609')
    expect(out.stops[1].state).toBe('IL')
    expect(out.format).toBe('E2OPEN')
  })

  it('takes the model shipment type only when it is a key on the list', () => {
    expect(tenderFromParse(PARSED, { shipmentType: 'HOT_SHOT' }).shipmentType).toBe('HOT_SHOT')
    expect(tenderFromParse(PARSED, { shipmentType: '' }).shipmentType).toBeUndefined()
    expect(tenderFromParse(PARSED, { shipmentType: 'Hot shot' }).shipmentType).toBeUndefined()
  })

  it('appends a stop the parser never found, typed by position', () => {
    const out = tenderFromParse({ format: null, stops: [] }, { stops: [{ city: 'CHICAGO' }, { city: 'DANVILLE' }] })
    expect(out.stops.map((s) => s.type)).toEqual(['pickup', 'delivery'])
  })

  it('is the prefill itself when the model answered nothing', () => {
    expect(tenderFromParse(PARSED, null)).toBe(PARSED)
  })
})

describe('proposalToPrefill', () => {
  it('links the customer only on an exact address match', () => {
    const matched = proposalToPrefill(
      run({ partyKind: 'CUSTOMER', partyMatchHow: 'EMAIL', partyId: 'cus-batory', partyName: 'Batory Foods' }),
    )
    expect(matched.customerId).toBe('cus-batory')
    expect(matched.tender.customerId).toBe('cus-batory')

    const byDomain = proposalToPrefill(
      run({ partyKind: 'CUSTOMER', partyMatchHow: 'DOMAIN', partyId: 'cus-batory', partyName: 'Batory Foods' }),
    )
    expect(byDomain.customerId).toBeUndefined()
    expect('customerId' in byDomain.tender).toBe(false)
    expect(byDomain.customerName).toBe('Batory Foods')

    const carrier = proposalToPrefill(
      run({ partyKind: 'CARRIER', partyMatchHow: 'EMAIL', partyId: 'car-ivan', partyName: 'Ivan Cartage' }),
    )
    expect(carrier.customerId).toBeUndefined()
  })

  it('puts the broker reference on the tender and never a PRO', () => {
    const seed = proposalToPrefill(run())
    expect(seed.tender.reference).toBe('TMS ID 208663813')
    expect('pro' in seed).toBe(false)
    expect('pro' in seed.tender).toBe(false)
    expect(seed.customerName).toBe('BATORY FOODS')
  })

  it('is an empty tender when the run proposed something else', () => {
    const seed = proposalToPrefill(run({ proposalKind: 'CAPACITY', proposal: { kind: 'CAPACITY' } }))
    expect(seed.tender).toEqual({ format: null, stops: [] })
  })

  it('seeds the dialog to raise a TENDER shipment pointed back at the run', () => {
    // Without these the applied tender lands as a MANUAL draft with no link, and
    // TENDER_RESPOND has nothing in TENDER_PENDING to accept.
    const seed = proposalToPrefill(run({ id: 'wf:TENDER:xyz' }))
    expect(seed.source).toBe('TENDER')
    expect(seed.workflowRunId).toBe('wf:TENDER:xyz')
  })
})

describe('what the model reads from a rate confirmation', () => {
  const BLANK: TenderPrefill = { format: null, stops: [] }
  it('carries equipment, commodity, the delivery number and the rate (dollars to cents), and the stop address and instructions', () => {
    const out = tenderFromParse(BLANK, {
      equipmentType: '53 dry van', commodity: 'Frozen foods', deliveryNumber: 'D-9', rateDollars: 1650.5,
      stops: [{ type: 'pickup', name: 'ACME', street: '1 Main St', city: 'Joliet', state: 'IL', zip: '60435', dateStr: '2026-11-11', time: '08:00', instructions: 'Dock 4' }],
    })
    expect(out).toMatchObject({ equipmentType: '53 dry van', commodity: 'Frozen foods', deliveryNumber: 'D-9', customerRateCents: 165050 })
    expect(out.stops[0]).toMatchObject({ street: '1 Main St', instructions: 'Dock 4' })
  })

  it('never takes a zero or missing rate, and the parser still outranks the model', () => {
    expect(tenderFromParse(BLANK, { rateDollars: 0 }).customerRateCents).toBeUndefined()
    expect(tenderFromParse({ ...BLANK, equipmentType: 'reefer', customerRateCents: 100 }, { equipmentType: 'van', rateDollars: 5 })).toMatchObject({ equipmentType: 'reefer', customerRateCents: 100 })
  })
})

