import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_REQUIREMENTS,
  evaluateReviewRequirements,
  normalizeReviewRequirements,
  profitFromFacts,
  resolveReviewRequirements,
  type ReviewFacts,
} from './reviewRequirements'
import { loadReviewExtras } from './loadReview'

const complete: ReviewFacts = {
  revDivision: 'BCAT', salesRepId: 'rep1', referenceNumber: 'PO-1', podReceived: true,
  revenueCents: 100_000, expenseCents: 80_000, profitCents: 20_000,
}

describe('resolveReviewRequirements', () => {
  it('falls through customer, then org default, then the built-in seven', () => {
    expect(resolveReviewRequirements(['salesRep'], ['revDivision'])).toEqual(['salesRep'])
    expect(resolveReviewRequirements(null, ['revDivision', 'salesRep'])).toEqual(['revDivision', 'salesRep'])
    expect(resolveReviewRequirements(undefined, undefined)).toEqual([...DEFAULT_REVIEW_REQUIREMENTS])
    expect(DEFAULT_REVIEW_REQUIREMENTS).toHaveLength(7)
  })

  it('treats an explicit empty customer list as "nothing required", not a fallthrough', () => {
    expect(resolveReviewRequirements([], ['salesRep'])).toEqual([])
  })

  it('drops unknown keys and duplicates and keeps canonical order', () => {
    expect(normalizeReviewRequirements(['profitEntered', 'bogus', 'revDivision', 'revDivision'])).toEqual(['revDivision', 'profitEntered'])
  })
})

describe('evaluateReviewRequirements', () => {
  it('passes complete facts and reports every miss otherwise', () => {
    expect(evaluateReviewRequirements(DEFAULT_REVIEW_REQUIREMENTS, complete)).toEqual({ ok: true, failures: [] })
    const none = evaluateReviewRequirements(DEFAULT_REVIEW_REQUIREMENTS, {})
    expect(none.ok).toBe(false)
    expect(none.failures.map((f) => f.requirement)).toEqual([...DEFAULT_REVIEW_REQUIREMENTS])
  })

  it('judges the same facts differently per customer list', () => {
    const facts = { ...complete, salesRepId: null, expenseCents: null, profitCents: null }
    expect(evaluateReviewRequirements(['revDivision', 'podReceived'], facts).ok).toBe(true)
    expect(evaluateReviewRequirements(['salesRep', 'expenseEntered'], facts).failures.map((f) => f.requirement))
      .toEqual(['salesRep', 'expenseEntered'])
  })

  it('computes profit only once both revenue and expense are entered', () => {
    expect(profitFromFacts(100, 60)).toBe(40)
    expect(profitFromFacts(100, null)).toBeNull()
    expect(profitFromFacts(0, 60)).toBeNull()
  })
})

describe('the Load Review gate reads this same list', () => {
  it('loadReviewExtras refuses on exactly the requirement failures, customer list included', () => {
    const facts = { ...complete, revDivision: null, referenceNumber: null }
    for (const list of [DEFAULT_REVIEW_REQUIREMENTS, ['revDivision'], ['salesRep']] as const) {
      const direct = evaluateReviewRequirements(list, facts).failures.map((f) => f.code)
      const viaGate = loadReviewExtras({ shipment: {}, facts, requirements: list }).map((r) => r.code)
      expect(viaGate).toEqual(direct)
    }
  })
})
