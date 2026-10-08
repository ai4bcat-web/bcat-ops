import { describe, it, expect } from 'vitest'
import { MANUAL_STEPS, MANUAL_INVOICE_CC, manualProgress, withManualStep, isManualStepId } from './manualInvoice'

describe('the manual-invoice steps', () => {
  it('are the three the office does, in order', () => {
    expect(MANUAL_STEPS.map((s) => s.id)).toEqual(['billToUpdated', 'pdfExported', 'emailed'])
    expect(MANUAL_STEPS[0].label).toMatch(/bill-to in Aljex/)
    expect(MANUAL_STEPS[1].label).toMatch(/invoice PDF/)
    expect(MANUAL_STEPS[2].detail).toContain(MANUAL_INVOICE_CC)
  })

  it('counts progress and calls it complete only when all three are marked', () => {
    const mark = { at: '2026-10-08T16:00:00Z', by: 'ryne@bcatcorp.com' }
    expect(manualProgress(null)).toEqual({ done: 0, total: 3, complete: false })
    let s = withManualStep(null, 'billToUpdated', true, mark)
    expect(manualProgress(s)).toMatchObject({ done: 1, complete: false })
    s = withManualStep(s, 'pdfExported', true, mark)
    s = withManualStep(s, 'emailed', true, mark)
    expect(manualProgress(s)).toEqual({ done: 3, total: 3, complete: true })
    // Un-ticking reopens it.
    s = withManualStep(s, 'emailed', false, mark)
    expect(manualProgress(s)).toMatchObject({ done: 2, complete: false })
    expect(s.emailed).toBeNull()
  })

  it('rejects a step it does not know', () => {
    expect(isManualStepId('emailed')).toBe(true)
    expect(isManualStepId('faxed')).toBe(false)
  })
})
