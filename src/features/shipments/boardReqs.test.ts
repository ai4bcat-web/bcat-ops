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

  it('never drops an item: one the form cannot see is still listed, pointing at where to fix it', () => {
    const reqs = boardReqsOf(row({ reference: null, customerFactors: true, factorGaps: ['PO_MISSING'] }), SRC, NOW)
    const out = reqsAsIssues(reqs, [], [])
    expect(out).toHaveLength(reqs.length)
    expect(out[0]).toMatchObject({ label: 'PO / reference #', section: 'customer', fieldKey: 'f-customer-refNo' })
  })
})

describe('the chip count is the rail list (Ryne 2026-11-16: "14904 says need 1 but nothing displays")', () => {
  // 14904: THE ROYAL GROUP, brokerage, not factored, delivered, no POD on file. The board counts the POD (the customer's
  // Load Review list asks for it); the editor's own document check only asks on factored / asset loads, so it found
  // nothing and the rail used to drop the item.
  const fixtures: Array<[string, Partial<ShipmentRow>]> = [
    ['14904: brokerage, manual customer, delivered, no POD', { docsPresent: [], docsMissing: [], docsRequired: [] }],
    ['brokerage, FACTOR customer, no POD', { customerFactors: true, docsPresent: [], docsMissing: ['POD'] }],
    ['customer missing AP e-mail and billing method', { customerBillingGaps: ['CUSTOMER_AP_EMAIL', 'CUSTOMER_BILLING_METHOD'] }],
    ['no rep, no division, no rate', { salesRepId: null, revDivision: null, revenueCents: 0 }],
    ['factored, missing ZIPs', { customerFactors: true, factorGaps: ['PICKUP_ZIP', 'DELIVERY_ZIP'] }],
  ]
  for (const [name, over] of fixtures) {
    it(name, () => {
      const reqs = boardReqsOf(row(over), SRC, NOW)
      expect(reqs.length).toBeGreaterThan(0)
      const rail = reqsAsIssues(reqs, [], [], 'cus-1')
      expect(rail).toHaveLength(reqs.length)
      expect(rail.map((i) => i.label)).toEqual(reqs.map((r) => r.label))
      for (const i of rail) expect(Boolean(i.fieldKey) || Boolean(i.href) || Boolean(i.hint)).toBe(true)
    })
  }

  it('14904: the POD item points at the Documents upload box', () => {
    const reqs = boardReqsOf(row({ docsPresent: [], docsMissing: [], docsRequired: [] }), SRC, NOW)
    expect(reqs.map((r) => r.key)).toEqual(['doc:POD'])
    expect(reqsAsIssues(reqs, [], [], 'cus-1')[0]).toMatchObject({ section: 'documents', fieldKey: 'card-documents-slot-POD' })
  })

  it('a customer setting opens the customer editor on the shipment', () => {
    const reqs = boardReqsOf(row({ customerBillingGaps: ['CUSTOMER_AP_EMAIL'] }), SRC, NOW)
    expect(reqsAsIssues(reqs, [], [], 'cus-1')[0]).toMatchObject({ action: 'editCustomer', fieldKey: '' })
  })

  it('a customer setting with no customer linked points at the Link customer control', () => {
    const reqs = boardReqsOf(row({ customerBillingGaps: ['CUSTOMER_AP_EMAIL'] }), SRC, NOW)
    expect(reqsAsIssues(reqs, [], [], null)[0]).toMatchObject({ fieldKey: 'f-customer-change' })
  })

  it('every item in the list has a place to click through to', () => {
    const reqs = boardReqsOf(row({
      salesRepId: null, revDivision: null, revenueCents: 0, customerFactors: true,
      factorGaps: ['PICKUP_ZIP', 'DELIVERY_STATE', 'CUSTOMER_MC', 'BILLING_METHOD'], customerBillingGaps: ['CUSTOMER_AP_EMAIL'],
      docsPresent: [], docsMissing: ['POD'],
    }), SRC, NOW)
    const rail = reqsAsIssues(reqs, [], [], 'cus-1')
    expect(rail.length).toBeGreaterThan(5)
    for (const i of rail) expect(Boolean(i.fieldKey) || i.action === 'editCustomer').toBe(true)
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
  // On the board and waiting to be pushed: order at DOCS_NEEDED, linked to a customer.
  const onBoard = (over: Partial<ShipmentRow>) => row({ arStatus: 'DOCS_NEEDED', customerId: 'c1', assignmentType: 'CARRIER', ...over } as Partial<ShipmentRow>)

  it('lists only delivered rows the push would accept and REQS shows nothing for', async () => {
    const { readyForReviewOf, setBoardReqSources, boardReqsOf: reqsOf } = await import('./boardReqs')
    const { pushRefusals } = await import('./batchReview')
    const { matchesFlag } = await import('./boardChips')
    setBoardReqSources(SRC)
    const rows = [
      onBoard({ id: 'ok' }),
      onBoard({ id: 'no-rep', salesRepId: null }),
      onBoard({ id: 'moving', status: 'IN_TRANSIT' }),
      onBoard({ id: 'no-ap', customerBillingGaps: ['CUSTOMER_AP_EMAIL'] }),
      onBoard({ id: 'pushed', loadReviewPushedAt: '2026-11-15T00:00:00Z' } as Partial<ShipmentRow>),
      onBoard({ id: 'voided', voidedAt: '2026-11-15T00:00:00Z' }),
      onBoard({ id: 'no-customer', customerId: null }),
      onBoard({ id: 'released', arStatus: 'UNPAID' }),
      onBoard({ id: 'uncovered', assignmentType: 'NEED_TO_COVER' }),
      onBoard({ id: 'unassigned', assignmentType: null }),
    ]
    const ready = rows.filter((r) => readyForReviewOf(r, SRC)).map((r) => r.id)
    expect(ready).toEqual(['ok'])
    for (const r of rows.filter((x) => ready.includes(x.id))) {
      expect(pushRefusals([r], SRC)).toEqual([])
      expect(reqsOf(r, SRC)).toEqual([])
    }
    expect(rows.filter((r) => matchesFlag(r, 'readyForReview', NOW)).map((r) => r.id)).toEqual(['ok'])
  })

  it('never lists a load REQS flags (a factored load missing OTR fields, a missing POD)', async () => {
    const { readyForReviewOf } = await import('./boardReqs')
    expect(readyForReviewOf(onBoard({ customerFactors: true, factorGaps: ['PICKUP_ZIP'] }), SRC)).toBe(false)
    expect(readyForReviewOf(onBoard({ docsMissing: ['POD'], docsPresent: ['RATE_CON'] }), SRC)).toBe(false)
  })

  it('needs the POD known to be on file: a driver page awaiting review counts, an unknown gate does not', async () => {
    const { readyForReviewOf } = await import('./boardReqs')
    expect(readyForReviewOf(onBoard({ docsPresent: ['POD', 'RATE_CON'], docsPendingReview: ['POD'] } as Partial<ShipmentRow>), SRC)).toBe(true)
    expect(readyForReviewOf(onBoard({ docsMissing: null, docsRequired: null, docsPresent: null } as Partial<ShipmentRow>), SRC)).toBe(false)
  })

  it('is offered in the Status filter with a count equal to the flag', async () => {
    const { facetOptions } = await import('@/features/tms/grid/denseGridModel')
    const { READY_FOR_REVIEW_FILTER_VALUE, SHIPMENT_GRID_COLUMNS } = await import('./shipmentGridColumns')
    const { setBoardReqSources } = await import('./boardReqs')
    setBoardReqSources(SRC)
    const statusCol = SHIPMENT_GRID_COLUMNS.find((c) => c.key === 'status')!
    const rows = [onBoard({ id: 'a' }), onBoard({ id: 'b' }), onBoard({ id: 'c', salesRepId: null })]
    const facet = facetOptions(rows, statusCol).find((f) => f.value === READY_FOR_REVIEW_FILTER_VALUE)
    expect(facet?.label).toBe('Ready for review')
    expect(facet?.count).toBe(2)
  })
})
