import { describe, expect, it } from 'vitest'
import { evaluateLoadReview, LOAD_REVIEW_FIELDS, loadReviewFieldReasons, loadReviewFieldsOf, loadReviewNeeds, type LoadReviewRow } from './loadReview'

const base: LoadReviewRow = {
  id: 's1', number: '20031', status: 'DELIVERED', customerId: 'c1', arStatus: 'UNPAID', assignmentType: 'CARRIER',
  salesRepId: 'u1', revDivision: 'BCAT_LOGISTICS', docsRequired: ['POD', 'RATE_CON'], docsMissing: [],
  orderRevenueCents: 375533, costCents: 300000, reference: 'PO-1', customerReference: 'PO-1',
  loadReviewPushedAt: '2026-11-14T00:00:00.000Z',
}

describe('Load Review checked fields', () => {
  it('a clean load passes every field and needs nothing', () => {
    const verdict = evaluateLoadReview({ row: base })
    expect(verdict.ok).toBe(true)
    expect(loadReviewNeeds(verdict)).toEqual([])
  })

  it('each missing value lands on its own column', () => {
    const verdict = evaluateLoadReview({ row: { ...base, salesRepId: null, revDivision: null, reference: null, customerReference: null, costCents: null, docsMissing: ['POD', 'RATE_CON'] } })
    const reasons = loadReviewFieldReasons(verdict)
    for (const key of ['salesRep', 'revDivision', 'customerRef', 'carrierRate', 'profit', 'pod', 'rateCon'] as const) expect(reasons[key].length).toBeGreaterThan(0)
    expect(reasons.customerRate).toEqual([])
    expect(loadReviewNeeds(verdict)).toEqual(['Customer ref (PO)', 'POD', 'RC', 'Carrier rate', 'Profit', 'Sales rep', 'Rev division'])
  })

  it('every failing reason is claimed by a column, so all columns passing means ready', () => {
    const verdict = evaluateLoadReview({ row: { ...base, status: 'IN_TRANSIT', customerId: null, openIncidentCount: 2, buildState: 'BUILDING', stops: [{ city: '' }] } as LoadReviewRow })
    const reasons = loadReviewFieldReasons(verdict)
    const claimed = new Set(LOAD_REVIEW_FIELDS.flatMap((key) => reasons[key]))
    expect(verdict.ok).toBe(false)
    expect(claimed.size).toBe(Object.values(verdict.checks).flatMap((c) => c.reasons).length)
  })

  it('a missing document goes to POD or RC by type, anything else to Other checks', () => {
    expect(loadReviewFieldsOf({ code: 'DOC_MISSING', message: 'Missing document: POD' })).toEqual(['pod'])
    expect(loadReviewFieldsOf({ code: 'DOC_MISSING', message: 'Missing document: RATE_CON' })).toEqual(['rateCon'])
    expect(loadReviewFieldsOf({ code: 'DOC_MISSING', message: 'Missing document: BOL' })).toEqual(['other'])
    expect(loadReviewFieldsOf({ code: 'SOMETHING_NEW', message: 'x' })).toEqual(['other'])
  })
})
