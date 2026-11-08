/**
 * Pay-math snapshot (MERGE_REGRESSION T7).
 *
 * golden.json holds what origin/main's pure pay libs returned for fixture.json (synthetic,
 * production-shaped rows; no real names, e-mails, phones or rates). Every pay path — Amazon,
 * box truck, owner-operator percentage pay, the driver-app settlement, hourly pay, fleet
 * revenue — must return exactly those numbers on the merged tree, so a merge that quietly
 * changes a driver's check fails here instead of on a pay run.
 *
 * Regenerate ONLY when a pay rule is meant to change: run compute.ts against the extracted
 * origin/main tree (git archive origin/main src amplify/functions/driver-app-api).
 */
import { describe, it, expect } from 'vitest'
import { computePayGolden, type PayFixture } from './compute'
import fixture from './fixture.json'
import golden from './golden.json'

type Section = Record<string, unknown>
const actual = computePayGolden(fixture as unknown as PayFixture) as Section
const expected = golden as unknown as Section

describe('pay math is byte-identical to origin/main on production-shaped rows', () => {
  it.each(Object.keys(expected))('%s', (section) => {
    expect(actual[section]).toEqual(expected[section])
  })

  it('computes no section the golden file does not know about', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  })

  it('the fixture actually exercises each pay path (a vacuous snapshot proves nothing)', () => {
    const amazon = expected.amazon as { statement: { checkAmount: number; totalDebits: number; factoringFee: number } }[]
    const box = expected.boxTruck as { statement: { checkAmount: number; factoringFee: number }; pendingCredits: string[] }[]
    const oo = expected.ownerOperator as { held: unknown[]; statement: { checkAmount: number; factoringFee: number } }[]
    const app = expected.driverAppSettlement as { settlement: { heldFreight: number; trips: { heldReason: string | null }[] } }[]
    expect(amazon.some((r) => r.statement.checkAmount > 0 && r.statement.totalDebits > 0)).toBe(true)
    expect(amazon.every((r) => r.statement.factoringFee === 0)).toBe(true) // Amazon is never factored
    expect(box.some((r) => r.statement.factoringFee > 0 && r.pendingCredits.length > 0)).toBe(true)
    expect(oo.some((r) => r.held.length > 0 && r.statement.checkAmount > 0)).toBe(true)
    expect(app.some((r) => r.settlement.heldFreight > 0)).toBe(true)
    expect(app.some((r) => r.settlement.trips.some((t) => t.heldReason === 'NOT_DELIVERED'))).toBe(true)
  })
})
