import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PAGE_BUDGETS, PAGE_LABELS, evaluate, ratchet, checkSpecs, rewriteBudgets, percentile } from './perfBudgets.mjs'

const run = (settledS, requests = 10, mb = 1, firstRowsS = 1) => ({ firstRowsS, settledS, requests, mb })
const budget = { firstRows: 3, settled: 5, requests: 50, mb: 8 }

describe('ratchet', () => {
  it('only ever lowers a ceiling, even when the measurement is worse', () => {
    const current = { '/a': { firstRows: 3, settled: 5, requests: 50, mb: 8 } }
    const next = ratchet(current, { '/a': { firstRows: 0.4, settled: 9, requests: 7, mb: 0.5 } })
    expect(next['/a']).toEqual({ firstRows: 0.6, settled: 5, requests: 11, mb: 0.8 })
  })

  it('keeps ceilings for pages with no measurement', () => {
    const current = { '/a': { settled: 5 }, '/b': { settled: 4 } }
    expect(ratchet(current, { '/a': { settled: 1 } })).toEqual({ '/a': { settled: 1.5 }, '/b': { settled: 4 } })
  })
})

describe('evaluate', () => {
  it('passes when median and max are inside the ceilings', () => {
    expect(evaluate({ runs: [run(4), run(4.5), run(5)] }, budget).ok).toBe(true)
  })

  it('fails on the median even when one run is fast', () => {
    const r = evaluate({ runs: [run(1), run(6), run(6)] }, budget)
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/settled: median 6 > 5/)
  })

  it('fails on a single run above 1.5x the ceiling although the median passes', () => {
    const r = evaluate({ runs: [run(2), run(2), run(8)] }, budget)
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/max 8 > 7.5/)
  })

  it('treats rows that never appeared as a failure, not a pass', () => {
    const r = evaluate({ runs: [run(2, 10, 1, null), run(2), run(2)] }, budget)
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/firstRows: not reached/)
  })

  it('fails when nothing was measured', () => {
    expect(evaluate({ runs: [] }, budget).ok).toBe(false)
  })
})

describe('page specs', () => {
  it('a budgeted page with no measurement is reported', () => {
    const paths = Object.keys(PAGE_BUDGETS).filter((p) => p !== '/tms/customers')
    expect(checkSpecs(paths)).toEqual(['/tms/customers'])
  })

  it('every budgeted page has a label and vice versa', () => {
    expect(Object.keys(PAGE_LABELS).sort()).toEqual(Object.keys(PAGE_BUDGETS).sort())
  })

  it('rewriteBudgets round-trips through the file the ratchet rewrites', () => {
    const source = readFileSync(new URL('./perfBudgets.mjs', import.meta.url), 'utf8')
    expect(rewriteBudgets(source, PAGE_BUDGETS)).toBe(source)
    const lowered = ratchet(PAGE_BUDGETS, { '/tms/carriers': { settled: 1, requests: 5, mb: 1, firstRows: 1 } })
    const rewritten = rewriteBudgets(source, lowered)
    expect(rewritten).toContain("'/tms/carriers': { firstRows: 1.5, settled: 1.5, requests: 8, mb: 1.5 }")
  })
})

describe('percentile', () => {
  it('is the max for three runs at p95', () => {
    expect(percentile([3, 9, 1], 95)).toBe(9)
  })
})
