import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PAGE_BUDGETS, PAGE_LABELS, KPI_BUDGETS, evaluate, ratchet, checkSpecs, rewriteBudgets, percentile, evaluateKpi, ratchetKpi, rewriteKpiBudgets, checkKpiSpecs } from './perfBudgets.mjs'

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

describe('KPI budgets (Step AF)', () => {
  const k = (kpiS, extra = {}) => ({ kpiS, chartS: 2, lastChangeS: 3, requests: 20, mb: 2, kpiFlips: 1, ...extra })
  const three = (a, b, c, extra) => [k(a, extra), k(b, extra), k(c, extra)]
  const good = { cold: three(2, 2.4, 2.8), warm: three(1, 1.2, 1.4), spa: three(0.1, 0.3, 0.5) }
  const b = KPI_BUDGETS['/tms/dashboard']

  it('the committed ceilings are Ryne\'s numbers', () => {
    expect([b.cold, b.warm, b.spa]).toEqual([3, 1.5, 0.8])
    expect([KPI_BUDGETS['/dashboard'].cold, KPI_BUDGETS['/dashboard'].warm, KPI_BUDGETS['/dashboard'].spa]).toEqual([3, 1.5, 1])
  })

  it('passes inside the ceilings and fails on the median per mode', () => {
    expect(evaluateKpi(good, b).ok).toBe(true)
    const slow = { ...good, warm: three(1.6, 1.7, 1.8) }
    expect(evaluateKpi(slow, b).failures.join()).toMatch(/warm: median 1.7 > 1.5/)
  })

  it('fails on one run above 1.5 x the ceiling although the median passes', () => {
    const r = evaluateKpi({ ...good, spa: three(0.1, 0.1, 1.3) }, b)
    expect(r.failures.join()).toMatch(/spa: max 1.3 > 1.2/)
  })

  it('a KPI that never appeared, or a mode with no runs, is a failure not a pass', () => {
    expect(evaluateKpi({ ...good, cold: [k(null), k(2), k(2)] }, b).failures.join()).toMatch(/cold: not reached in 1\/3/)
    expect(evaluateKpi({ cold: good.cold, warm: [], spa: good.spa }, b).failures.join()).toMatch(/warm: no warm runs/)
  })

  it('a second KPI flip in any run fails (cache -> rollup is the only allowed change)', () => {
    expect(evaluateKpi({ ...good, cold: three(2, 2, 2, { kpiFlips: 2 }) }, b).failures.join()).toMatch(/kpiFlips: max 2 > 1.5/)
  })

  it('a KPI spec with no measurement is reported', () => {
    expect(checkKpiSpecs(['/tms/dashboard'])).toEqual(['/dashboard'])
  })

  it('ratchet only lowers, leaves the flips contract, and rewrites its own block', () => {
    const next = ratchetKpi(KPI_BUDGETS, { '/tms/dashboard': { cold: 9, warm: 0.4, spa: 0.1, spaRequests: 10, kpiFlips: 0 } })
    expect(next['/tms/dashboard']).toMatchObject({ cold: 3, warm: 0.6, spa: 0.2, spaRequests: 15, kpiFlips: 1 })
    const source = readFileSync(new URL('./perfBudgets.mjs', import.meta.url), 'utf8')
    expect(rewriteKpiBudgets(source, KPI_BUDGETS)).toBe(source)
    expect(rewriteKpiBudgets(source, next)).toContain("'/tms/dashboard': { cold: 3, warm: 0.6, spa: 0.2")
  })
})
