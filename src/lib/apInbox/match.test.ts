import { describe, expect, it } from 'vitest'
import { DEFAULT_AP_INBOX_CONFIG } from './constants'
import { decide, rankCandidates } from './match'
import { FX_CARRIER, fxAssignment, fxBill, fxExtraction, fxLedger, fxVendor } from './fixtures'

const cfg = DEFAULT_AP_INBOX_CONFIG
const run = (ext = fxExtraction(), ledger = fxLedger(), runState = { autoApplied: 0 }, config = cfg) => {
  const candidates = rankCandidates(ext, ledger)
  return { candidates, d: decide(ext, candidates, ledger, config, runState) }
}

describe('§6.6 worked examples', () => {
  it('PRO + MC + amount on a placeholder IN_REVIEW bill = 0.95 and AUTO, writing number/dates/amount', () => {
    const { candidates, d } = run()
    expect(candidates[0].score).toBe(0.95)
    expect(d.outcome).toBe('AUTO')
    expect(d.plan?.fields).toEqual(['billNumber', 'billDate', 'dueAt', 'billedCents'])
  })

  it('PRO + exact carrier name + amount = 0.90 and AUTO', () => {
    const { candidates, d } = run(fxExtraction({ issuer: { name: 'Swift Haul LLC', kind: 'CARRIER', mc: null, dot: null } }))
    expect(candidates[0].score).toBe(0.9)
    expect(d.outcome).toBe('AUTO')
  })

  it('PRO with no carrier info queues as LOW_CONFIDENCE (0.70)', () => {
    const { candidates, d } = run(fxExtraction({ issuer: { name: null, kind: 'UNKNOWN', mc: null, dot: null } }))
    expect(candidates[0].score).toBe(0.7)
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'LOW_CONFIDENCE' })
  })

  it('PRO exact but a different MC is vetoed and never auto-applies', () => {
    const { candidates, d } = run(fxExtraction({ issuer: { name: 'Swift Haul LLC', kind: 'CARRIER', mc: '555555', dot: null } }))
    expect(candidates[0].vetoes).toContain('CARRIER_CONTRADICTS')
    expect(candidates[0].signals.map((s) => s.key)).toContain('CARRIER_CONTRADICTS')
    expect(d.outcome).toBe('REVIEW')
    expect(d.top?.targetId).toBe('bill-1')
  })

  it("the mail's MC belonging to a different directory carrier is a contradiction", () => {
    const { candidates } = run(fxExtraction({ issuer: { name: 'Blue Ridge Freight', kind: 'CARRIER', mc: '999888', dot: null } }))
    expect(candidates[0].vetoes).toContain('CARRIER_CONTRADICTS')
  })

  it("invoice # equal to the bill's real number: attach + CONFLICT, dates are not overwritten", () => {
    const ledger = fxLedger({ bills: [fxBill({ billNumber: 'SH-5521', billDate: '2026-10-20', dueAt: '2026-11-19' })] })
    const { candidates, d } = run(fxExtraction({ pros: [] }), ledger)
    expect(candidates[0].score).toBe(0.9)
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'CONFLICT', attach: true })
    expect(d.plan?.set).toEqual({})
  })

  it('carrier + exact amount without PRO / invoice # / ref is 0.60 and never auto', () => {
    const ledger = fxLedger({ bills: [fxBill({ shipmentNumber: 'S000777-1', loadNumber: 'S000777-1' })] })
    const { candidates, d } = run(fxExtraction({ pros: [] }), ledger)
    expect(candidates[0].score).toBe(0.6)
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'LOW_CONFIDENCE' })
  })

  it('one PRO on two legs is AMBIGUOUS', () => {
    const ledger = fxLedger({ bills: [fxBill(), fxBill({ id: 'bill-2', loadCarrierId: 'lc-2', loadNumber: 'S000101-2' })] })
    const { candidates, d } = run(fxExtraction(), ledger)
    expect(candidates.map((c) => c.score)).toEqual([0.95, 0.95])
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'AMBIGUOUS' })
  })

  it('model confidence medium caps the score at 0.84', () => {
    const { candidates, d } = run(fxExtraction({ confidence: 'medium' }))
    expect(candidates[0].score).toBe(0.84)
    expect(d.reason).toBe('LOW_CONFIDENCE')
  })

  it('low model confidence is AI_UNSURE', () => {
    // A low-confidence read is capped at 0.49; with a lowered review floor it surfaces as AI_UNSURE.
    expect(run(fxExtraction({ confidence: 'low' }), fxLedger(), { autoApplied: 0 }, { ...cfg, reviewMinScore: 0.3 }).d.reason).toBe('AI_UNSURE')
  })

  it('TO_BE_PAID bill with a blank number: AUTO writes number and dates, never the amount', () => {
    const ledger = fxLedger({ bills: [fxBill({ status: 'TO_BE_PAID' })] })
    const { d } = run(fxExtraction(), ledger)
    expect(d.outcome).toBe('AUTO')
    expect(d.plan?.fields).toEqual(['billNumber', 'billDate', 'dueAt'])
  })

  it('an AWAITING_INVOICE assignment attaches and queues NO_BILL_YET', () => {
    const ledger = fxLedger({ bills: [], assignments: [fxAssignment({ shipmentNumber: 'S000101-1' })] })
    const { d } = run(fxExtraction(), ledger)
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'NO_BILL_YET', attach: true })
    expect(d.top?.targetKind).toBe('LOAD_CARRIER')
  })

  it('vendor mail: invoice # + exact vendor name + amount = 0.90, AUTO fills the blank dates only', () => {
    const ledger = fxLedger({ bills: [], vendorPayables: [fxVendor()] })
    const ext = fxExtraction({
      pros: [], issuer: { name: 'Acme Tire Co', kind: 'VENDOR', mc: null, dot: null }, invoiceNumber: 'AT-7781', amountCents: 48_000,
    })
    const { candidates, d } = run(ext, ledger)
    expect(candidates[0].score).toBe(0.9)
    expect(d.outcome).toBe('AUTO')
    expect(d.plan?.fields).toEqual(['invoiceDate', 'dueDate'])
  })
})

describe('guards', () => {
  it('auto-apply off queues everything as AUTO_OFF', () => {
    expect(run(fxExtraction(), fxLedger(), { autoApplied: 0 }, { ...cfg, autoApply: false }).d.reason).toBe('AUTO_OFF')
  })

  it('the per-run cap queues the next one as RUN_CAP', () => {
    expect(run(fxExtraction(), fxLedger(), { autoApplied: 50 }).d.reason).toBe('RUN_CAP')
  })

  it('the threshold floor is 0.85 even if a caller passes a lower one', () => {
    const ledger = fxLedger({ bills: [fxBill({ carrierMc: FX_CARRIER.mcNumber })] })
    // PRO + carrier name fuzzy only = 0.70: never auto, whatever the configured threshold.
    const ext = fxExtraction({ issuer: { name: 'Swift Haul Transport Inc', kind: 'CARRIER', mc: null, dot: null }, amountCents: null })
    const { d } = run(ext, ledger, { autoApplied: 0 }, { ...cfg, autoApplyMinScore: 0.3 })
    expect(d.outcome).toBe('REVIEW')
  })

  it('a credit memo is always queued as CREDIT', () => {
    expect(run(fxExtraction({ kind: 'CREDIT_MEMO' })).d.reason).toBe('CREDIT')
  })

  it('a remit-to that contradicts the carrier on file vetoes auto-apply', () => {
    const { d } = run(fxExtraction({ remitTo: { name: 'Quick Cash Factoring', text: 'Quick Cash Factoring, PO Box 9' } }))
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'REMIT_MISMATCH' })
  })

  it('a remit-to naming the carrier is fine', () => {
    expect(run(fxExtraction({ remitTo: { name: 'Swift Haul', text: null } })).d.outcome).toBe('AUTO')
  })

  it('a PARTIAL bill takes attachments only: STATUS review', () => {
    const { d } = run(fxExtraction(), fxLedger({ bills: [fxBill({ status: 'PARTIAL' })] }))
    expect(d).toMatchObject({ outcome: 'REVIEW', reason: 'STATUS' })
  })

  it('a weak reference (customer PO / trip #) never reaches auto', () => {
    const ledger = fxLedger({ bills: [fxBill({ shipmentNumber: 'S000555-1', loadNumber: 'S000555-1', refs: ['PU-8890'] })] })
    const { candidates, d } = run(fxExtraction({ pros: [], otherRefs: ['PU-8890'] }), ledger)
    expect(candidates[0].signals.map((s) => s.key)).toContain('REF')
    expect(candidates[0].score).toBeLessThan(0.9)
    expect(d.outcome).toBe('REVIEW')
  })

  it("an Aljex bill carrying the load's PRO as its number is a placeholder: AUTO replaces it", () => {
    const ledger = fxLedger({ bills: [fxBill({ aljexId: '14452', shipmentNumber: null, loadNumber: null, billNumber: '14452' })] })
    const { d } = run(fxExtraction({ pros: ['14452'] }), ledger)
    expect(d.outcome).toBe('AUTO')
    expect(d.plan?.set).toMatchObject({ billNumber: 'SH-5521' })
  })

  it('fuzzy names count for 0.10 only when the token sets are near-identical', () => {
    const near = rankCandidates(fxExtraction({ issuer: { name: 'Swift Haul Transport Inc', kind: 'CARRIER', mc: null, dot: null } }), fxLedger())[0]
    expect(near.signals.map((s) => s.key)).toContain('CARRIER_FUZZY')
    const far = rankCandidates(fxExtraction({ issuer: { name: 'Swift Hall', kind: 'CARRIER', mc: null, dot: null } }), fxLedger())[0]
    expect(far.signals.map((s) => s.key)).not.toContain('CARRIER_FUZZY')
  })

  it('an amount more than 25% off costs 0.25', () => {
    const c = rankCandidates(fxExtraction({ amountCents: 300_000 }), fxLedger())[0]
    expect(c.signals.find((s) => s.key === 'AMOUNT_FAR')?.points).toBe(-0.25)
    expect(c.score).toBe(0.6)
  })
})
