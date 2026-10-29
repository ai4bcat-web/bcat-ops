import { describe, it, expect } from 'vitest'

import { evaluateReleaseGate, releaseGateError, releaseGateOf, type ReleaseGateInput } from './releaseGate'

/** A delivered brokered shipment with everything in hand, which every test bends. */
function input(overrides: Partial<ReleaseGateInput> = {}): ReleaseGateInput {
  return {
    shipment: { status: 'DELIVERED', voidedAt: null, deletedAt: null },
    order: { arStatus: 'DOCS_NEEDED', references: [{ code: 'PO', value: '44821' }], invoiceId: null },
    requiredDocTypes: [],
    requiredReferenceCodes: ['PO'],
    referenceLabels: { PO: 'PO number' },
    documents: [
      { type: 'BOL', status: 'ACTIVE', reviewStatus: 'ACCEPTED' },
      { type: 'POD', status: 'ACTIVE', reviewStatus: 'ACCEPTED' },
    ],
    legs: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }],
    openIncidentCount: 0,
    ...overrides,
  }
}

const messages = (gate: ReleaseGateInput): string[] => evaluateReleaseGate(gate).missing.map((m) => m.message)

describe('evaluateReleaseGate', () => {
  it('releases a delivered shipment with its paperwork, references and an own truck', () => {
    expect(evaluateReleaseGate(input())).toEqual({ ok: true, missing: [] })
  })

  it('refuses a voided shipment and says nothing else, because nothing else matters', () => {
    const gate = evaluateReleaseGate(
      input({
        shipment: { status: 'DELIVERED', voidedAt: '2026-10-21T00:00:00.000Z' },
        documents: [],
        legs: [],
        openIncidentCount: 4,
      }),
    )
    expect(gate.ok).toBe(false)
    expect(gate.missing).toEqual([{ code: 'VOIDED', detail: null, message: 'Voided shipment' }])
  })

  it('treats a pre-R soft delete as a void', () => {
    expect(messages(input({ shipment: { status: 'DELIVERED', deletedAt: '2026-10-21T00:00:00.000Z' } })))
      .toEqual(['Voided shipment'])
  })

  it('refuses a canceled shipment on its own', () => {
    expect(messages(input({ shipment: { status: 'CANCELED' }, documents: [], legs: [] })))
      .toEqual(['Canceled shipment'])
  })

  it('names the status a shipment is stuck on when it has not delivered', () => {
    const gate = evaluateReleaseGate(input({ shipment: { status: 'BOOKED' } }))
    expect(gate.missing[0]).toEqual({
      code: 'NOT_DELIVERED',
      detail: 'BOOKED',
      message: 'Not delivered yet (status BOOKED)',
    })
  })

  it('requires the BOL and the POD even when the customer asks for neither', () => {
    expect(messages(input({ documents: [] }))).toEqual(['Missing document: BOL', 'Missing document: POD'])
  })

  it('asks for every type the customer bills on, in their order', () => {
    expect(messages(input({ requiredDocTypes: ['LUMPER_RECEIPT', 'POD'], documents: [] }))).toEqual([
      'Missing document: LUMPER_RECEIPT',
      'Missing document: POD',
      'Missing document: BOL',
    ])
  })

  it('does not count a carrier-portal upload nobody has accepted yet', () => {
    expect(
      messages(
        input({
          documents: [
            { type: 'BOL', status: 'ACTIVE', reviewStatus: 'ACCEPTED' },
            { type: 'POD', status: 'ACTIVE', reviewStatus: 'PENDING', audience: 'ALL' },
          ],
        }),
      ),
    ).toEqual(['Missing document: POD'])
  })

  it('does not count a refused, voided or superseded document', () => {
    for (const doc of [
      { type: 'POD', status: 'ACTIVE', reviewStatus: 'REJECTED' },
      { type: 'POD', status: 'ACTIVE', voidedAt: '2026-10-22T00:00:00.000Z' },
      { type: 'POD', status: 'VOID', reviewStatus: 'ACCEPTED' },
      { type: 'POD', status: 'SUPERSEDED', reviewStatus: 'ACCEPTED' },
    ]) {
      expect(messages(input({ documents: [{ type: 'BOL', status: 'ACTIVE' }, doc] })))
        .toEqual(['Missing document: POD'])
    }
  })

  it('wants a rate confirmation once somebody else’s truck is on the load', () => {
    const carrierLeg = { kind: 'CARRIER' as const, status: 'ACTIVE', carrierName: 'Wheeler', chargesFinalizedAt: 'x' }
    expect(messages(input({ legs: [carrierLeg] }))).toEqual(['Missing document: RATE_CON'])
    expect(messages(input({ legs: [{ ...carrierLeg, rateConStatus: 'SIGNED' }] }))).toEqual([])
  })

  it('asks nothing extra of an own-fleet leg: no rate con, no carrier bill', () => {
    expect(evaluateReleaseGate(input({ legs: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }] })))
      .toEqual({ ok: true, missing: [] })
  })

  it('names a missing reference by the label the customer configured', () => {
    const gate = evaluateReleaseGate(input({ order: { arStatus: 'DOCS_NEEDED', references: [] } }))
    expect(gate.missing).toEqual([
      { code: 'REFERENCE_MISSING', detail: 'PO', message: 'Missing reference: PO number' },
    ])
  })

  it('falls back to the code when nothing labelled it, and blank is not a value', () => {
    expect(
      messages(
        input({
          referenceLabels: null,
          order: { arStatus: 'DOCS_NEEDED', references: [{ code: 'PO', value: '   ' }] },
        }),
      ),
    ).toEqual(['Missing reference: PO'])
  })

  it('refuses a shipment nobody is hauling', () => {
    expect(messages(input({ legs: [] }))).toEqual(['No carrier or driver assigned'])
  })

  it('refuses an outside carrier whose bill has not been recorded, and names them', () => {
    const gate = evaluateReleaseGate(
      input({
        documents: [
          { type: 'BOL', status: 'ACTIVE' },
          { type: 'POD', status: 'ACTIVE' },
          { type: 'RATE_CON', status: 'ACTIVE' },
        ],
        legs: [{ kind: 'CARRIER', status: 'ACTIVE', carrierName: 'Wheeler Trucking', chargesFinalizedAt: null }],
      }),
    )
    expect(gate.missing).toEqual([
      {
        code: 'CARRIER_CHARGES_UNSETTLED',
        detail: 'Wheeler Trucking',
        message: 'Carrier charges not settled: Wheeler Trucking — record the carrier bill first',
      },
    ])
  })

  it('ignores a bounced leg entirely: it is neither assigned nor owed', () => {
    expect(messages(input({ legs: [{ kind: 'CARRIER', status: 'BOUNCED', carrierName: 'Wheeler' }] })))
      .toEqual(['No carrier or driver assigned'])
  })

  it('counts open exceptions, singular and plural', () => {
    expect(messages(input({ openIncidentCount: 1 }))).toEqual(['1 open exception'])
    const gate = evaluateReleaseGate(input({ openIncidentCount: 2 }))
    expect(gate.missing).toEqual([{ code: 'OPEN_EXCEPTIONS', detail: '2', message: '2 open exceptions' }])
  })

  it('never lets an invoice-early order out before the truck has delivered', () => {
    // `invoiceEarly` is not an input here, and that is the point: step R removed
    // every flag that admitted an undelivered order.
    expect(messages(input({ shipment: { status: 'IN_TRANSIT' } }))).toEqual([
      'Not delivered yet (status IN_TRANSIT)',
    ])
  })

  it('lists every reason at once, in contract order', () => {
    const gate = evaluateReleaseGate(
      input({
        shipment: { status: 'IN_TRANSIT' },
        order: { arStatus: 'DOCS_NEEDED', references: [] },
        documents: [],
        legs: [{ kind: 'CARRIER', status: 'ACTIVE', carrierName: 'Wheeler' }],
        openIncidentCount: 2,
      }),
    )
    expect(gate.missing.map((m) => m.code)).toEqual([
      'NOT_DELIVERED',
      'DOC_MISSING',
      'DOC_MISSING',
      'DOC_MISSING',
      'REFERENCE_MISSING',
      'CARRIER_CHARGES_UNSETTLED',
      'OPEN_EXCEPTIONS',
    ])
  })
})

describe('releaseGateError', () => {
  it('joins the sentences into one message the client can parse, and carries the list', () => {
    const { missing } = evaluateReleaseGate(input({ shipment: { status: 'BOOKED' }, documents: [] }))
    const err = releaseGateError(missing)
    expect(err.message).toBe(
      'Not ready for accounting: Not delivered yet (status BOOKED); Missing document: BOL; Missing document: POD',
    )
    expect(releaseGateOf(err)?.missing.map((m) => m.code)).toEqual(['NOT_DELIVERED', 'DOC_MISSING', 'DOC_MISSING'])
  })

  it('reads nothing structured off an ordinary error', () => {
    expect(releaseGateOf(new Error('boom'))).toBeNull()
    expect(releaseGateOf(null)).toBeNull()
  })
})
