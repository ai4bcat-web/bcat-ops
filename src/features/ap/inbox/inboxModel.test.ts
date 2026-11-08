import { describe, it, expect } from 'vitest'
import { inboxItem } from './inboxTestkit'
import { needsConfirm, suggestedLabel, undoBlockedReason } from './inboxModel'

describe('needsConfirm', () => {
  it('asks for a check on a low-confidence suggestion, and on any target other than the suggested one', () => {
    expect(needsConfirm(inboxItem(), 'b1')).toBe(true)
    const certain = inboxItem({ reviewReason: 'CONFLICT' })
    expect(needsConfirm(certain, 'b1')).toBe(false)
    expect(needsConfirm(certain, 'b2')).toBe(true)
  })

  it('always asks when nothing was suggested or the suggestion carries a veto', () => {
    expect(needsConfirm(inboxItem({ match: null }), 'b1')).toBe(true)
    const vetoed = inboxItem({ reviewReason: 'CONFLICT' })
    vetoed.match!.top!.vetoes = ['REMIT_MISMATCH']
    expect(needsConfirm(vetoed, 'b1')).toBe(true)
  })
})

describe('undoBlockedReason', () => {
  it('allows undo only where fields were written', () => {
    const applied = { at: 'x', by: 'ap-inbox', mode: 'AUTO' as const, before: {}, after: {}, fields: ['billNumber'] }
    expect(undoBlockedReason(inboxItem({ status: 'APPLIED', applied }))).toBeNull()
    expect(undoBlockedReason(inboxItem({ status: 'APPLIED', applied: { ...applied, fields: [] } }))).toMatch(/nothing/i)
    expect(undoBlockedReason(inboxItem({ status: 'DISMISSED' }))).toMatch(/applied/i)
  })
})

describe('suggestedLabel', () => {
  it('names the carrier and shipment, and is null without a suggestion', () => {
    expect(suggestedLabel(inboxItem())).toBe('Blue Line Trucking · S-100')
    expect(suggestedLabel(inboxItem({ match: null }))).toBeNull()
  })
})
