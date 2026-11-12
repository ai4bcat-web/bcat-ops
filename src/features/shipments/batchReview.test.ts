import { describe, expect, it } from 'vitest'
import {
  MAX_REVIEW_BATCH,
  outcomesFromServer,
  pushRefusals,
  requirementsForRow,
  reviewFactsOfRow,
  selectAllUpToCap,
  toggleSelection,
} from './batchReview'
import type { ShipmentRow } from './shipmentViews'

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id,
    number: id,
    customerId: 'c1',
    revDivision: 'DRY',
    salesRepId: 'rep-1',
    reference: 'PO-1',
    docsRequired: ['POD'],
    docsMissing: [],
    revenueCents: 100_000,
    costCents: 80_000,
    ...patch,
  } as ShipmentRow
}

const none = { customers: [], orgDefault: null }

describe('review facts of a board row', () => {
  it('reads a complete shipment as meeting every requirement', () => {
    expect(pushRefusals([row('S1')], none)).toEqual([])
  })

  it('takes the reference from the order reference or the customer reference', () => {
    expect(reviewFactsOfRow(row('S1', { reference: null, customerReference: 'CR-9' })).referenceNumber).toBe('CR-9')
    expect(reviewFactsOfRow(row('S1', { reference: null, customerReference: null })).referenceNumber).toBeNull()
  })

  it('counts POD received only when the customer requires one and the gate does not list it missing', () => {
    expect(reviewFactsOfRow(row('S1')).podReceived).toBe(true)
    expect(reviewFactsOfRow(row('S1', { docsMissing: ['POD'] })).podReceived).toBe(false)
  })

  it('treats POD as unknown (null) when the gate has not run or POD is not on the customer\'s list', () => {
    expect(reviewFactsOfRow(row('S1', { docsMissing: null })).podReceived).toBeNull()
    expect(reviewFactsOfRow(row('S1', { docsRequired: ['BOL'], docsMissing: [] })).podReceived).toBeNull()
  })

  it('does not refuse a push on a POD the row cannot speak for: the server reads the documents', () => {
    // 20027: delivered, POD column reads in, customer's document list does not include POD.
    expect(pushRefusals([row('S1', { docsRequired: ['BOL'], docsMissing: [] })], none)).toEqual([])
    expect(pushRefusals([row('S1', { docsMissing: null })], none)).toEqual([])
    // Where POD is required and listed missing, it is still refused here with the sentence.
    const out = pushRefusals([row('S1', { docsMissing: ['POD'] })], none)
    expect(out).toHaveLength(1)
    expect(out[0]!.reasons).toContain('POD not received')
  })

  it('gives every reason a row fails, per row', () => {
    const out = pushRefusals([row('S1'), row('S2', { revDivision: null, salesRepId: null, reference: null, costCents: null })], none)
    expect(out.map((o) => o.rowId)).toEqual(['S2'])
    expect(out[0].reasons).toEqual(expect.arrayContaining([
      'Missing revenue division',
      'Missing reference #',
      'Missing sales rep',
      'No expense entered',
    ]))
  })
})

describe('requirements per customer and organization', () => {
  const customers = [
    { id: 'c1', reviewRequirements: ['salesRep'] },
    { id: 'c2', reviewRequirements: null },
    { id: 'c3', reviewRequirements: [] },
  ]
  it('a customer list overrides the org default, which overrides the built-in seven', () => {
    expect(requirementsForRow({ customerId: 'c1' }, { customers, orgDefault: ['revDivision'] })).toEqual(['salesRep'])
    expect(requirementsForRow({ customerId: 'c2' }, { customers, orgDefault: ['revDivision'] })).toEqual(['revDivision'])
    expect(requirementsForRow({ customerId: 'zz' }, { customers, orgDefault: null })).toHaveLength(7)
    expect(requirementsForRow({ customerId: 'c3' }, { customers, orgDefault: ['revDivision'] })).toEqual([])
  })

  it('a row passes under its customer list even when the org default would refuse it', () => {
    const bare = row('S1', { salesRepId: null, customerId: 'c1' })
    expect(pushRefusals([bare], { customers: [{ id: 'c1', reviewRequirements: ['revDivision'] }], orgDefault: ['salesRep'] })).toEqual([])
    expect(pushRefusals([bare], { customers: [{ id: 'c1', reviewRequirements: null }], orgDefault: ['salesRep'] })).toHaveLength(1)
  })
})

describe('the nine-row cap', () => {
  const nine = Array.from({ length: MAX_REVIEW_BATCH }, (_, i) => `S${i}`)
  it('takes nine and refuses the tenth with a message', () => {
    const next = toggleSelection(nine, 'S9')
    expect(next.ids).toEqual(nine)
    expect(next.refusal).toMatch(/at most 9/)
  })
  it('still lets a selected row be deselected at the cap', () => {
    expect(toggleSelection(nine, 'S3')).toEqual({ ids: nine.filter((x) => x !== 'S3'), refusal: null })
  })
  it('select-all takes the first nine and says so; a short list takes all without a message', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `R${i}`)
    const all = selectAllUpToCap([], ids)
    expect(all.ids).toEqual(ids.slice(0, 9))
    expect(all.refusal).toMatch(/at most 9/)
    expect(selectAllUpToCap([], ids.slice(0, 4))).toEqual({ ids: ids.slice(0, 4), refusal: null })
  })
  it('select-all on a fully selected list clears it', () => {
    expect(selectAllUpToCap(['R0', 'R1'], ['R0', 'R1']).ids).toEqual([])
  })
})

describe('server outcomes', () => {
  it('keeps partial success visible and prefers the reasons list', () => {
    const out = outcomesFromServer(
      [
        { shipmentId: 'a', number: 'S-a', ok: true, message: 'Already in Load Review' },
        { shipmentId: 'b', number: null, ok: false, message: 'Refused', reasons: ['Missing sales rep', 'POD not received'] },
        { shipmentId: 'c', number: 'S-c', ok: false, message: 'Boom' },
      ],
      (_id, fallback) => fallback ?? '?',
    )
    expect(out[0]).toMatchObject({ ok: true, note: 'Already in Load Review', reasons: [] })
    expect(out[1].reasons).toEqual(['Missing sales rep', 'POD not received'])
    expect(out[2].reasons).toEqual(['Boom'])
  })
})
