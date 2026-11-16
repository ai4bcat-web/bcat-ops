import { describe, expect, it } from 'vitest'
import { boardReqsOf, reqsAsIssues } from './boardReqs'
import type { FormIssue } from './form/sectionProps'
import type { ShipmentRow } from './shipmentViews'

// Noon Chicago on Nov 16, 2026.
const NOW = Date.parse('2026-11-16T18:00:00Z')
const SRC = { customers: [], orgDefault: null }
const complete: Partial<ShipmentRow> = {
  revDivision: 'BROKERAGE', salesRepId: 'rep-1', reference: 'PO-1', revenueCents: 100000, costCents: 80000,
  docsRequired: ['POD', 'RATE_CON'], docsMissing: [], docsPresent: ['POD', 'RATE_CON'],
}
const row = (over: Partial<ShipmentRow>): ShipmentRow => ({ id: 's1', number: '1', status: 'DELIVERED', ...complete, ...over }) as ShipmentRow
const keys = (r: ShipmentRow) => boardReqsOf(r, SRC, NOW).map((x) => x.key)

describe('REQS: Push to load review + factoring, one list', () => {
  it('is empty when nothing is missing', () => {
    expect(boardReqsOf(row({}), SRC, NOW)).toEqual([])
  })

  it('lists the push gate items and the customer billing gaps', () => {
    expect(keys(row({ salesRepId: null, revDivision: null, customerBillingGaps: ['CUSTOMER_AP_EMAIL'] })))
      .toEqual(['revDivision', 'salesRep', 'customer:CUSTOMER_AP_EMAIL'])
  })

  it('counts the PO once when review and factoring both miss it', () => {
    const r = row({ reference: null, customerFactors: true, factorGaps: ['PO_MISSING', 'PICKUP_ZIP'] })
    expect(keys(r)).toEqual(['po', 'factor:PICKUP_ZIP'])
  })

  it('does not list profit separately when the rate or the cost is already listed', () => {
    expect(keys(row({ revenueCents: null }))).toEqual(['customerRate'])
    expect(keys(row({ costCents: null }))).toEqual(['expense'])
  })

  it('never asks an asset load for expense or profit', () => {
    expect(keys(row({ revDivision: 'ASSETS', costCents: null }))).toEqual([])
  })

  it('stage-gates the POD: not counted before delivery, counted once delivered', () => {
    const open = row({ status: 'BOOKED', deliveryAppt: '2026-11-20T14:00:00Z', customerFactors: true, docsMissing: ['POD'], docsPresent: ['RATE_CON'] })
    expect(keys(open)).not.toContain('doc:POD')
    const delivered = row({ status: 'DELIVERED', customerFactors: true, docsMissing: ['POD'], docsPresent: ['RATE_CON'] })
    expect(keys(delivered)).toContain('doc:POD')
  })

  it('counts the POD on a load past its delivery date', () => {
    const late = row({ status: 'IN_TRANSIT', deliveryAppt: '2026-11-10T14:00:00Z', customerFactors: true, docsMissing: ['POD'], docsPresent: ['RATE_CON'] })
    expect(keys(late)).toContain('doc:POD')
  })
})

describe('REQS in the editor rail', () => {
  it('lists exactly the chip items, pointing at a field where the form has one', () => {
    const reqs = boardReqsOf(row({ reference: null, salesRepId: null, customerFactors: true, factorGaps: ['PO_MISSING'] }), SRC, NOW)
    const po: FormIssue = { id: 'customer:ref:po', section: 'customer', fieldKey: 'f-po', label: 'PO', message: 'PO', severity: 'warn', marked: true }
    const out = reqsAsIssues(reqs, [po], [])
    expect(out).toHaveLength(reqs.length)
    expect(out.find((i) => i.id === 'customer:ref:po')?.fieldKey).toBe('f-po')
    expect(out.find((i) => i.id === 'req:salesRep')?.section).toBe('roles')
  })

  it('drops a form-owned item once the form no longer finds it missing', () => {
    const reqs = boardReqsOf(row({ reference: null, customerFactors: true, factorGaps: ['PO_MISSING'] }), SRC, NOW)
    expect(reqsAsIssues(reqs, [], [])).toEqual([])
  })
})

describe('REQS export text', () => {
  it('exports the combined list, not the factoring-only text', async () => {
    const { boardReqsListText, setBoardReqSources } = await import('./boardReqs')
    const { reqsExportText } = await import('./shipmentViews')
    setBoardReqSources(SRC)
    const r = row({ salesRepId: null, reference: null, customerFactors: true, factorGaps: ['PO_MISSING', 'PICKUP_ZIP'] })
    const text = reqsExportText(r)
    expect(text).toBe(boardReqsListText(boardReqsOf(r, SRC)))
    expect(text).toContain('Sales rep')
    expect(reqsExportText(row({}))).toBe('')
  })
})

describe('Ready for review (Active filter + header stat)', () => {
  it('matches exactly the delivered rows Push to load review would accept', async () => {
    const { readyForReviewOf, setBoardReqSources } = await import('./boardReqs')
    const { pushRefusals } = await import('./batchReview')
    const { matchesFlag } = await import('./boardChips')
    setBoardReqSources(SRC)
    const rows = [
      row({ id: 'ok' } as Partial<ShipmentRow>),
      row({ id: 'no-rep', salesRepId: null } as Partial<ShipmentRow>),
      row({ id: 'moving', status: 'IN_TRANSIT' } as Partial<ShipmentRow>),
      row({ id: 'no-ap', customerBillingGaps: ['CUSTOMER_AP_EMAIL'] } as Partial<ShipmentRow>),
      row({ id: 'pushed', loadReviewPushedAt: '2026-11-15T00:00:00Z' } as Partial<ShipmentRow>),
      row({ id: 'voided', voidedAt: '2026-11-15T00:00:00Z' } as Partial<ShipmentRow>),
    ]
    const ready = rows.filter((r) => readyForReviewOf(r, SRC)).map((r) => r.id)
    expect(ready).toEqual(['ok'])
    const live = rows.filter((r) => !r.voidedAt && !(r as { loadReviewPushedAt?: string }).loadReviewPushedAt)
    const accepted = live.filter((r) => pushRefusals([r], SRC).length === 0).map((r) => r.id)
    expect(ready).toEqual(accepted)
    expect(rows.filter((r) => matchesFlag(r, 'readyForReview', NOW)).map((r) => r.id)).toEqual(['ok'])
  })

  it('is offered in the Status filter with a count equal to the flag', async () => {
    const { facetOptions } = await import('@/features/tms/grid/denseGridModel')
    const { READY_FOR_REVIEW_FILTER_VALUE, SHIPMENT_GRID_COLUMNS } = await import('./shipmentGridColumns')
    const { setBoardReqSources } = await import('./boardReqs')
    setBoardReqSources(SRC)
    const statusCol = SHIPMENT_GRID_COLUMNS.find((c) => c.key === 'status')!
    const rows = [row({ id: 'a' } as Partial<ShipmentRow>), row({ id: 'b' } as Partial<ShipmentRow>), row({ id: 'c', salesRepId: null } as Partial<ShipmentRow>)]
    const facet = facetOptions(rows, statusCol).find((f) => f.value === READY_FOR_REVIEW_FILTER_VALUE)
    expect(facet?.label).toBe('Ready for review')
    expect(facet?.count).toBe(2)
  })
})
