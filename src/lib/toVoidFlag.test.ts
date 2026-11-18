import { describe, expect, it } from 'vitest'
import {
  TO_VOID_NOTE_MAX, TO_VOID_REASON_MAX, parseToVoidFlag, toVoidSummary, toVoidTooltip, validateToVoidInput,
} from './toVoidFlag'

describe('validateToVoidInput', () => {
  it('requires a reason', () => {
    expect(() => validateToVoidInput({})).toThrow(/say why/)
    expect(() => validateToVoidInput({ reason: '   ' })).toThrow(/say why/)
    expect(() => validateToVoidInput(null)).toThrow(/send the flag details/)
    expect(() => validateToVoidInput([])).toThrow(/send the flag details/)
  })

  it('trims the reason and the note, and drops an empty note', () => {
    expect(validateToVoidInput({ reason: '  Duplicate of 14872 ', note: '  ' })).toEqual({ reason: 'Duplicate of 14872', note: null })
    expect(validateToVoidInput({ reason: 'Cancelled', note: ' call the dock ' })).toEqual({ reason: 'Cancelled', note: 'call the dock' })
  })

  it('refuses a reason or note that is too long, or a note that is not text', () => {
    expect(() => validateToVoidInput({ reason: 'x'.repeat(TO_VOID_REASON_MAX + 1) })).toThrow(/reason is too long/)
    expect(() => validateToVoidInput({ reason: 'ok', note: 'x'.repeat(TO_VOID_NOTE_MAX + 1) })).toThrow(/note is too long/)
    expect(() => validateToVoidInput({ reason: 'ok', note: 5 })).toThrow(/must be text/)
  })
})

describe('parseToVoidFlag', () => {
  const stored = { reason: 'Duplicate', note: null, flaggedAt: '2026-11-18T15:00:00.000Z', flaggedBy: 'dennis@bcatcorp.com' }

  it('reads an object or the JSON string AppSync hands back', () => {
    expect(parseToVoidFlag(stored)).toEqual(stored)
    expect(parseToVoidFlag(JSON.stringify(stored))).toEqual(stored)
  })

  it('returns null for anything that is not a stamped flag with a reason', () => {
    expect(parseToVoidFlag(null)).toBeNull()
    expect(parseToVoidFlag(undefined)).toBeNull()
    expect(parseToVoidFlag('not json')).toBeNull()
    expect(parseToVoidFlag([])).toBeNull()
    expect(parseToVoidFlag({ reason: 'x' })).toBeNull()
    expect(parseToVoidFlag({ flaggedAt: '2026-11-18T15:00:00.000Z' })).toBeNull()
  })
})

describe('wording', () => {
  const flag = { reason: 'Duplicate of 14872', note: 'Same PO', flaggedAt: '2026-11-18T15:00:00.000Z', flaggedBy: 'dennis@bcatcorp.com' }

  it('summarises with the reason', () => {
    expect(toVoidSummary(flag)).toBe('To void · Duplicate of 14872')
  })

  it('writes the tooltip with reason, note, who and when', () => {
    expect(toVoidTooltip(flag, () => 'Nov 18, 9:00 AM').split('\n')).toEqual([
      'Flagged to void: Duplicate of 14872',
      'Same PO',
      'Flagged by dennis@bcatcorp.com · Nov 18, 9:00 AM',
    ])
    expect(toVoidTooltip({ ...flag, note: null }, () => 'x').split('\n')).toHaveLength(2)
  })
})
