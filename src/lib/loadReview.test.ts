import { describe, expect, it } from 'vitest'
import { releaseGateMessages } from '@/features/shipments/components/releaseGateView'
import {
  GATE_CODE_CHECK,
  LOAD_REVIEW_CHECKS,
  evaluateLoadReview,
  failingReasons,
  inLoadReviewQueue,
  loadReviewCount,
  loadReviewExtras,
  loadReviewRefusal,
  pendingApRecordNotes,
  releasedWithin,
  reviewAgeDays,
  type LoadReviewCheckKey,
  type LoadReviewRow,
} from './loadReview'
import { RELEASE_GATE_ERROR_PREFIX, releaseGateOf, type ReleaseGateReasonCode, type ReleaseGateResult } from './releaseGate'

const delivered = (over: Partial<LoadReviewRow> = {}): LoadReviewRow => ({
  loadReviewPushedAt: '2026-11-03T00:00:00Z', // in the queue: Load Review membership is the push stamp
  id: 's1',
  number: 'S-1',
  status: 'DELIVERED',
  deliveredAt: '2026-11-01T12:00:00Z',
  arStatus: 'DOCS_NEEDED',
  customerId: 'c1',
  salesRepId: 'rep1',
  revDivision: 'BCAT',
  assignmentType: 'OWN_ASSET',
  docsRequired: ['BOL', 'POD'],
  docsMissing: [],
  openIncidentCount: 0,
  orderRevenueCents: 120_000,
  reference: 'PO-1',
  costCents: 95_000,
  stops: [
    { type: 'PICKUP', city: 'Chicago, IL', appt: '2026-10-28T08:00' },
    { type: 'DELIVERY', city: 'Dallas, TX', appt: '2026-10-30T08:00' },
  ],
  ...over,
})

const gate = (...missing: Array<[ReleaseGateReasonCode, string]>): ReleaseGateResult => ({
  ok: missing.length === 0,
  missing: missing.map(([code, message]) => ({ code, detail: null, message })),
})

describe('inLoadReviewQueue', () => {
  it('lists only loads that were released to review, however they stand', () => {
    expect(inLoadReviewQueue(delivered())).toBe(true)
    // Delivered is not enough on its own (Aljex: a load enters Load Review when it is released to it).
    expect(inLoadReviewQueue(delivered({ loadReviewPushedAt: null }))).toBe(false)
    expect(inLoadReviewQueue(delivered({ loadReviewPushedAt: null, loadStatus: 'DELIVERED' }))).toBe(false)
    // A pushed load stays in the queue whatever the delivery clock says.
    expect(inLoadReviewQueue(delivered({ status: 'IN_TRANSIT', deliveredAt: null }))).toBe(true)
  })

  it('drops every released form', () => {
    expect(inLoadReviewQueue(delivered({ readyToInvoiceAt: '2026-11-02T00:00:00Z' }))).toBe(false)
    expect(inLoadReviewQueue(delivered({ invoiceId: 'inv1' }))).toBe(false)
    expect(inLoadReviewQueue(delivered({ arStatus: 'UNBILLED' }))).toBe(false)
  })

  it('keeps imported history that was pushed, and drops voided, deleted and canceled', () => {
    expect(inLoadReviewQueue(delivered({ legacyImported: true }))).toBe(true)
    expect(inLoadReviewQueue(delivered({ legacyImported: true, loadReviewPushedAt: null }))).toBe(false)
    expect(inLoadReviewQueue(delivered({ voidedAt: '2026-11-02T00:00:00Z' }))).toBe(false)
    expect(inLoadReviewQueue(delivered({ deletedAt: '2026-11-02T00:00:00Z' }))).toBe(false)
    expect(inLoadReviewQueue(delivered({ status: 'CANCELED' }))).toBe(false)
  })

  it('keeps a pushed load with no order and flags it', () => {
    const row = delivered({ arStatus: null })
    expect(inLoadReviewQueue(row)).toBe(true)
    const verdict = evaluateLoadReview({ row })
    expect(verdict.ok).toBe(false)
    expect(verdict.checks.details.reasons.map((r) => r.code)).toContain('NO_ORDER')
  })
})

describe('loadReviewCount', () => {
  it('counts only queued rows', () => {
    const rows = [delivered(), delivered({ id: 's2' }), delivered({ id: 's3', arStatus: 'UNBILLED' }), delivered({ id: 's4', loadReviewPushedAt: null })]
    expect(loadReviewCount(rows)).toBe(2)
  })
})

describe('pushed rows', () => {
  it('enter the queue before they deliver, and leave it once released', () => {
    const early = delivered({ status: 'IN_TRANSIT', deliveredAt: null, loadReviewPushedAt: '2026-11-03T00:00:00Z' })
    expect(inLoadReviewQueue(early)).toBe(true)
    expect(inLoadReviewQueue({ ...early, readyToInvoiceAt: '2026-11-04T00:00:00Z' })).toBe(false)
    expect(inLoadReviewQueue({ ...early, voidedAt: '2026-11-04T00:00:00Z' })).toBe(false)
  })
})

describe('releasedWithin', () => {
  const now = Date.parse('2026-11-04T00:00:00Z')
  it('honours the lookback window', () => {
    expect(releasedWithin(delivered({ readyToInvoiceAt: '2026-10-25T00:00:00Z' }), now)).toBe(true)
    expect(releasedWithin(delivered({ readyToInvoiceAt: '2026-10-10T00:00:00Z' }), now)).toBe(false)
  })
  it('excludes unreleased, legacy and voided rows', () => {
    expect(releasedWithin(delivered(), now)).toBe(false)
    expect(releasedWithin(delivered({ readyToInvoiceAt: '2026-11-01T00:00:00Z', legacyImported: true }), now)).toBe(false)
    expect(releasedWithin(delivered({ readyToInvoiceAt: '2026-11-01T00:00:00Z', voidedAt: '2026-11-02T00:00:00Z' }), now)).toBe(false)
  })
})

describe('reviewAgeDays', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  it('floors whole days and never goes negative', () => {
    expect(reviewAgeDays({ deliveredAt: '2026-11-01T18:00:00Z' }, now)).toBe(2)
    expect(reviewAgeDays({ deliveredAt: '2026-11-05T00:00:00Z' }, now)).toBe(0)
  })
  it('is null without a usable delivery time', () => {
    expect(reviewAgeDays({ deliveredAt: null }, now)).toBeNull()
    expect(reviewAgeDays({ deliveredAt: 'garbage' }, now)).toBeNull()
  })
})

describe('gate code mapping', () => {
  // Typed as the full union: adding a gate code without extending this list fails to compile.
  const ALL: Record<ReleaseGateReasonCode, true> = {
    VOIDED: true, CANCELED: true, NOT_DELIVERED: true, DOC_MISSING: true, REFERENCE_MISSING: true,
    CARRIER_NOT_ASSIGNED: true, DRIVER_MISSING: true, CARRIER_RATE_MISSING: true, OPEN_EXCEPTIONS: true,
  }

  it('maps every ReleaseGateReasonCode to a real check, and a supplied gate lands each under it', () => {
    for (const code of Object.keys(ALL) as ReleaseGateReasonCode[]) {
      const check = GATE_CODE_CHECK[code]
      expect(LOAD_REVIEW_CHECKS).toContain(check)
      const verdict = evaluateLoadReview({ row: delivered(), gate: gate([code, `msg ${code}`]) })
      expect(verdict.checks[check].reasons.map((r) => r.message)).toContain(`msg ${code}`)
      expect(verdict.ok).toBe(false)
    }
  })

  it('groups documents and carrier charges under their own headings, the rest under details', () => {
    const grouped: Record<LoadReviewCheckKey, ReleaseGateReasonCode[]> = { salesRep: [], revDivision: [], details: [], charges: [], documents: [] }
    for (const code of Object.keys(ALL) as ReleaseGateReasonCode[]) grouped[GATE_CODE_CHECK[code]].push(code)
    expect(grouped.documents).toEqual(['DOC_MISSING'])
    expect(grouped.charges).toEqual(['CARRIER_RATE_MISSING'])
    expect(grouped.salesRep).toEqual([])
    expect(grouped.revDivision).toEqual([])
  })
})

describe('loadReviewExtras', () => {
  const facts = {
    revDivision: 'BCAT', salesRepId: 'rep1', referenceNumber: 'PO-1', podReceived: true,
    revenueCents: 100, expenseCents: 60, profitCents: 40,
  }

  it('passes a complete load against the default seven', () => {
    expect(loadReviewExtras({ shipment: {}, facts })).toEqual([])
  })

  it('flags every failing requirement in list order, each under its own check', () => {
    const out = loadReviewExtras({ shipment: {}, facts: {} })
    expect(out.map((r) => [r.code, r.check])).toEqual([
      ['REV_DIVISION_MISSING', 'revDivision'],
      ['REFERENCE_NUMBER_MISSING', 'details'],
      ['POD_MISSING', 'documents'],
      ['SALES_REP_MISSING', 'salesRep'],
      ['NO_CUSTOMER_CHARGES', 'charges'],
      ['EXPENSE_MISSING', 'charges'],
      ['PROFIT_MISSING', 'charges'],
    ])
  })

  it('treats blank-only strings and non-positive money as missing', () => {
    const out = loadReviewExtras({
      shipment: {}, facts: { ...facts, revDivision: '   ', revenueCents: -5, expenseCents: 0 },
      requirements: ['revDivision', 'revenueEntered', 'expenseEntered'],
    })
    expect(out.map((r) => r.code)).toEqual(['REV_DIVISION_MISSING', 'NO_CUSTOMER_CHARGES', 'EXPENSE_MISSING'])
  })

  it('only checks what the customer asked for', () => {
    expect(loadReviewExtras({ shipment: {}, facts: { ...facts, salesRepId: null }, requirements: ['revDivision'] })).toEqual([])
    expect(loadReviewExtras({ shipment: {}, facts: { ...facts, salesRepId: null }, requirements: [] })).toEqual([])
  })

  it('exempts imported history entirely', () => {
    expect(loadReviewExtras({ shipment: { legacyImported: true }, facts: {} })).toEqual([])
  })

  it('attaches the fix action for rep and division', () => {
    const out = loadReviewExtras({ shipment: {}, facts: { ...facts, salesRepId: null, revDivision: null } })
    expect(out.map((r) => r.action)).toEqual([{ kind: 'SET_REV_DIVISION' }, { kind: 'SET_SALES_REP' }])
  })
})

describe('evaluateLoadReview — cached row verdict', () => {
  it('does not hold a carrier load for a bill that is not recorded: the move to billing creates it', () => {
    const verdict = (carriers: { apStatus: 'AWAITING_INVOICE' | 'TO_BE_PAID' }[]) =>
      evaluateLoadReview({ row: delivered({ assignmentType: 'CARRIER', apStatus: 'TO_BE_PAID', carriers }) })
    expect(verdict([{ apStatus: 'TO_BE_PAID' }, { apStatus: 'AWAITING_INVOICE' }]).checks.charges.ok).toBe(true)
    expect(verdict([{ apStatus: 'AWAITING_INVOICE' }]).ok).toBe(true)
  })

  it('passes a clean delivered row', () => {
    const verdict = evaluateLoadReview({ row: delivered() })
    expect(verdict.ok).toBe(true)
    expect(failingReasons(verdict)).toEqual([])
    expect(verdict.warnings).toEqual([])
  })

  it('fails each check independently with the sentence for it', () => {
    const verdict = evaluateLoadReview({
      row: delivered({ salesRepId: null, revDivision: '', docsMissing: ['POD'], orderRevenueCents: 0 }),
    })
    expect(verdict.checks.salesRep.reasons.map((r) => r.message)).toEqual(['Missing sales rep'])
    expect(verdict.checks.revDivision.reasons.map((r) => r.message)).toEqual(['Missing revenue division'])
    expect(verdict.checks.documents.reasons.map((r) => r.message)).toEqual(['Missing document: POD'])
    expect(verdict.checks.charges.reasons.map((r) => r.message)).toEqual(['No customer charges', 'Profit not available (needs revenue and expense)'])
    expect(verdict.checks.details.ok).toBe(true)
  })

  it('fails Documents when docs have not been checked', () => {
    const verdict = evaluateLoadReview({ row: delivered({ docsMissing: null }) })
    expect(verdict.checks.documents.ok).toBe(false)
  })

  it('derives details failures from the row', () => {
    const verdict = evaluateLoadReview({
      row: delivered({ status: 'IN_TRANSIT', assignmentType: 'NEED_TO_COVER', openIncidentCount: 2, buildState: 'BUILDING', customerId: null }),
    })
    expect(verdict.checks.details.reasons.map((r) => r.message)).toEqual([
      'Not delivered yet (status IN_TRANSIT)',
      'No carrier or driver assigned',
      '2 open exceptions',
      'No customer linked',
      'Still being built — required fields are missing',
    ])
  })

  it('uses a singular exception sentence', () => {
    const verdict = evaluateLoadReview({ row: delivered({ openIncidentCount: 1 }) })
    expect(verdict.checks.details.reasons.map((r) => r.message)).toEqual(['1 open exception'])
  })

  it('honours the caller customerUnresolved fact over the customerId default', () => {
    expect(evaluateLoadReview({ row: delivered(), customerUnresolved: true }).checks.details.reasons.map((r) => r.code)).toEqual(['NO_CUSTOMER'])
    expect(evaluateLoadReview({ row: delivered({ customerId: null }), customerUnresolved: false }).ok).toBe(true)
  })

  it('names the stop and the missing piece', () => {
    const verdict = evaluateLoadReview({
      row: delivered({
        stops: [
          { city: 'Chicago, IL', appt: '2026-10-28T08:00' },
          { city: '', appt: '2026-10-30T08:00' },
          { city: 'Dallas', appt: '2026-10-30T09:00' },
          { city: 'Austin, TX', appt: ' ' },
        ],
      }),
    })
    expect(verdict.checks.details.reasons.map((r) => r.message)).toEqual([
      'Stop 2 needs a city',
      'Stop 3 needs a state',
      'Stop 4 needs an appointment',
    ])
  })

  it('never fails the charges check on a missing carrier bill, whatever the rung', () => {
    const carrier = (apStatus: LoadReviewRow['apStatus']) =>
      evaluateLoadReview({ row: delivered({ assignmentType: 'CARRIER', apStatus }) }).checks.charges.reasons.map((r) => r.code)
    expect(carrier(null)).toEqual([])
    expect(carrier('AWAITING_INVOICE')).toEqual([])
    expect(carrier('APPROVED')).toEqual([])
  })

  it('says which AP records the move will create, one per carrier without a bill, and nothing for own trucks or billed carriers', () => {
    expect(pendingApRecordNotes(delivered({ assignmentType: 'CARRIER', carrierName: 'SHERIFAJ TRUCKING INC', apStatus: 'AWAITING_INVOICE', costCents: 140_000 })))
      .toEqual(['AP record will be created for SHERIFAJ TRUCKING INC — $1,400.00 when moved to billing'])
    expect(pendingApRecordNotes(delivered({ assignmentType: 'CARRIER', apStatus: null, costCents: 0 }))).toEqual(['AP record will be created for the carrier when moved to billing'])
    expect(pendingApRecordNotes(delivered({
      assignmentType: 'CARRIER',
      carriers: [{ name: 'Swift', apStatus: 'IN_REVIEW', costCents: 60_000 }, { name: 'Heartland', apStatus: 'AWAITING_INVOICE', costCents: 20_000 }],
    }))).toEqual(['AP record will be created for Heartland — $200.00 when moved to billing'])
    expect(pendingApRecordNotes(delivered({ assignmentType: 'OWN_ASSET', apStatus: null }))).toEqual([])
    expect(pendingApRecordNotes(delivered({ assignmentType: 'CARRIER', apStatus: 'TO_BE_PAID' }))).toEqual([])
  })

  it('failingReasons follows the fixed checklist order', () => {
    const verdict = evaluateLoadReview({ row: delivered({ salesRepId: null, docsMissing: ['POD'], openIncidentCount: 1, revDivision: null }) })
    expect(failingReasons(verdict).map((r) => r.check)).toEqual(['salesRep', 'revDivision', 'details', 'documents'])
  })
})

describe('negative margin', () => {
  it('is a warning and never blocks', () => {
    const verdict = evaluateLoadReview({ row: delivered({ orderRevenueCents: 100_000, costCents: 112_350 }) })
    expect(verdict.ok).toBe(true)
    expect(verdict.checks.charges.ok).toBe(true)
    expect(verdict.warnings).toEqual(['Cost exceeds revenue by $124'])
  })

  it('is silent at break-even and when either side is unknown', () => {
    expect(evaluateLoadReview({ row: delivered({ orderRevenueCents: 5000, costCents: 5000 }) }).warnings).toEqual([])
    expect(evaluateLoadReview({ row: delivered({ costCents: null }) }).warnings).toEqual([])
  })

  it('still warns alongside a gate-supplied verdict', () => {
    const verdict = evaluateLoadReview({ row: delivered({ orderRevenueCents: 100, costCents: 300_000 }), gate: gate() })
    expect(verdict.warnings).toEqual(['Cost exceeds revenue by $2,999'])
  })
  it('blocks an inactive revenue division under its own check, and passes an active one', () => {
    const inactive = evaluateLoadReview({ row: delivered(), revDivisionActive: false })
    expect(inactive.ok).toBe(false)
    expect(inactive.checks.revDivision.reasons.map((r) => r.code)).toEqual(['REV_DIVISION_INACTIVE'])
    expect(inactive.checks.revDivision.reasons[0].action).toEqual({ kind: 'SET_REV_DIVISION' })
    expect(evaluateLoadReview({ row: delivered(), revDivisionActive: true }).ok).toBe(true)
    expect(evaluateLoadReview({ row: delivered() }).ok).toBe(true)
  })

  it('reports a missing division once, not also as inactive', () => {
    const verdict = evaluateLoadReview({ row: delivered({ revDivision: null }), revDivisionActive: false })
    expect(verdict.checks.revDivision.reasons.map((r) => r.code)).toEqual(['REV_DIVISION_MISSING'])
  })


  it('reports pending carrier uploads as a warning with correct plurals', () => {
    expect(evaluateLoadReview({ row: delivered({ pendingDocReviewCount: 1 }) }).warnings).toEqual(['1 carrier upload is still awaiting review'])
    const two = evaluateLoadReview({ row: delivered({ pendingDocReviewCount: 2 }) })
    expect(two.warnings).toEqual(['2 carrier uploads are still awaiting review'])
    expect(two.ok).toBe(true)
  })
})

describe('evaluateLoadReview — gate-supplied verdict', () => {
  it('ignores stale cached gate facts when the authoritative gate is given', () => {
    // The row says POD is missing and nobody is assigned; the server gate says all clear.
    const row = delivered({ docsMissing: ['POD'], assignmentType: 'NEED_TO_COVER', openIncidentCount: 3, status: 'BOOKED' })
    const verdict = evaluateLoadReview({ row, gate: gate() })
    expect(verdict.checks.documents.ok).toBe(true)
    expect(verdict.checks.details.reasons.filter((r) => r.code !== 'NO_ORDER')).toEqual([])
  })

  it('prints gate sentences verbatim and links them to a tab', () => {
    const verdict = evaluateLoadReview({
      row: delivered(),
      gate: gate(['REFERENCE_MISSING', 'Missing reference: PO number'], ['DOC_MISSING', 'Missing document: POD']),
    })
    expect(verdict.checks.details.reasons[0]).toMatchObject({ message: 'Missing reference: PO number', action: { kind: 'OPEN_TAB', tab: 'overview' } })
    expect(verdict.checks.documents.reasons[0]).toMatchObject({ message: 'Missing document: POD', action: { kind: 'OPEN_TAB', tab: 'documents' } })
  })

  it('uses supplied extras instead of recomputing from the row', () => {
    const row = delivered({ salesRepId: null })
    const withExtras = evaluateLoadReview({ row, gate: gate(), extras: [] })
    expect(withExtras.ok).toBe(true)
    const recomputed = evaluateLoadReview({ row, gate: gate() })
    expect(recomputed.checks.salesRep.ok).toBe(false)
  })

  it('keeps the row-level extras (customer, stops, no order) even with a clean gate', () => {
    const verdict = evaluateLoadReview({ row: delivered({ customerId: null, arStatus: null }), gate: gate() })
    expect(verdict.checks.details.reasons.map((r) => r.code)).toEqual(['NO_CUSTOMER', 'NO_ORDER'])
  })
})

describe('loadReviewRefusal', () => {
  it('round-trips through releaseGateMessages, one entry per reason', () => {
    const extras = loadReviewExtras({ shipment: {}, facts: { revenueCents: 0 }, requirements: ['salesRep', 'revDivision', 'revenueEntered'] })
    const err = loadReviewRefusal([{ code: 'DOC_MISSING', message: 'Missing document: POD' }, ...extras])
    expect(err.message.startsWith(RELEASE_GATE_ERROR_PREFIX)).toBe(true)
    expect(releaseGateMessages(err.message)).toEqual([
      'Missing document: POD',
      'Missing revenue division',
      'Missing sales rep',
      'No customer charges',
    ])
  })

  it('carries the structured list for clients that read it', () => {
    const err = loadReviewRefusal([{ code: 'SALES_REP_MISSING', message: 'Missing sales rep' }])
    const structured = releaseGateOf(err)
    expect(structured?.ok).toBe(false)
    expect(structured?.missing.map((m) => m.message)).toEqual(['Missing sales rep'])
  })

  it('the page and the refusal agree: the sentences the checklist shows are the ones refused', () => {
    const row = delivered({ salesRepId: null, orderRevenueCents: 0 })
    const verdict = evaluateLoadReview({ row })
    const sentences = failingReasons(verdict).map((r) => r.message)
    const err = loadReviewRefusal(failingReasons(verdict))
    expect(releaseGateMessages(err.message)).toEqual(sentences)
  })
})

describe('factoring fields (Ryne 2026-11-14)', () => {
  it('a factored row missing what OTR needs fails Load details, and points at the stops for a ZIP', () => {
    const verdict = evaluateLoadReview({ row: delivered({ factorGaps: ['PO_MISSING', 'DELIVERY_ZIP'] }) })
    const factor = verdict.checks.details.reasons.filter((r) => r.code.startsWith('FACTOR_'))
    expect(factor.map((r) => r.message)).toEqual(['Missing for factoring: PO', 'Missing for factoring: Consignee ZIP'])
    expect(factor[1].action).toEqual({ kind: 'OPEN_TAB', tab: 'stops' })
    expect(verdict.ok).toBe(false)
  })

  it('imported history and the server extras do not repeat it', () => {
    expect(failingReasons(evaluateLoadReview({ row: delivered({ factorGaps: ['PO_MISSING'], legacyImported: true }) })).some((r) => r.code.startsWith('FACTOR_'))).toBe(false)
    expect(failingReasons(evaluateLoadReview({ row: delivered({ factorGaps: ['PO_MISSING'] }), extras: [] })).some((r) => r.code.startsWith('FACTOR_'))).toBe(false)
  })
})
