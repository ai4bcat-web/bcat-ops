import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { DORMANT_PAGES, DORMANT_ROUTES, dormantPageForPath, type DormantPageKey } from './dormantPages'
import { LAST_MODEL_STAGE, MODEL_STAGE, PRODUCTION_MODELS } from '../../amplify/data/stages'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

describe('page -> models table', () => {
  it.each(Object.entries(DORMANT_PAGES))('%s lists only merge-added models and names the stage that deploys the last one', (_key, page) => {
    for (const model of page.models) expect(PRODUCTION_MODELS.has(model), `${model} is a production model`).toBe(false)
    const stage = Math.max(...page.models.map((m) => MODEL_STAGE[m] ?? LAST_MODEL_STAGE))
    expect(page.stage).toBe(stage)
  })

  it('points every route at a page in the table', () => {
    for (const r of DORMANT_ROUTES) expect(DORMANT_PAGES[r.page], r.path).toBeDefined()
  })

  it('resolves the more specific path first', () => {
    expect(dormantPageForPath('/tms/shipments/intake?division=bcat')).toBe('intake')
    expect(dormantPageForPath('/tms/shipments/SHP-1')).toBe('shipments')
    expect(dormantPageForPath('/tms/invoicing/payable/bills/b1')).toBe('invoicingAp')
    expect(dormantPageForPath('/tms/invoicing/invoices/i1')).toBe('invoicingAr')
    expect(dormantPageForPath('/tms/carriers/find')).toBe('carriers')
    expect(dormantPageForPath('/tms/carriers/c1')).toBe('carrierProfile')
    expect(dormantPageForPath('/tms/brokerage/company/data/aljex-reconciliation')).toBe('aljexReconciliation')
    expect(dormantPageForPath('/tms/brokerage/company/data')).toBe('dataSafety')
  })

  it('leaves the pages that run on production models alone', () => {
    for (const path of ['/calendar', '/dispatch', '/files', '/tms/customers', '/tms/locations', '/tms/vendors', '/tms/factors', '/tms/brokerage', '/tms/brokerage/users', '/tms/brokerage/audit', '/tms/brokerage/company/company', '/tms/brokerage/carrier-sales']) {
      expect(dormantPageForPath(path), path).toBeNull()
    }
  })
})

/** The routes that open a page on production models alone (or delegate to a component that guards itself). */
const LIVE_ROUTES = new Set([
  'customers', 'locations', 'vendors', 'factors',
  'brokerage/*', // BrokeragePage guards each tab
  // BrokeragePage tabs
  'brokerage:', 'brokerage:users', 'brokerage:audit', 'brokerage:carrier-sales', 'brokerage:company/*', 'brokerage:*',
  // CompanyTab pages
  'company:company', 'company:billing', 'company:branding', 'company:notifications', 'company:account', 'company:*',
])
const REDIRECT = /<(Navigate|ParamRedirect|SavedViewRedirect|TmsIndexRedirect)\b/

interface RouteLine { source: string; local: string; text: string; full: string }

function routesOf(source: string, file: string, prefix: string, scope?: RegExp): RouteLine[] {
  const lines = read(file).split('\n')
  const rows: RouteLine[] = []
  for (const text of lines) {
    const m = /<Route\s[^>]*?path="([^"]*)"/.exec(text) ?? (/<Route\s[^>]*?index\b/.test(text) ? ['', ''] : null)
    if (!m || (scope && !scope.test(text))) continue
    const local = m[1]
    rows.push({ source, local, text, full: `${prefix}${local}`.replace(/\/$/, '') })
  }
  return rows
}

describe('route wrapping', () => {
  // App.tsx: the `/tms` block only (the rest of the file is production pages and redirects).
  const appLines = read('App.tsx').split('\n')
  const start = appLines.findIndex((l) => l.includes('<Route path="/tms">'))
  const end = appLines.findIndex((l, i) => i > start && l.includes('</Route>'))
  const tmsBlock = appLines.slice(start + 1, end)
  const tms: RouteLine[] = tmsBlock.flatMap((text) => {
    const m = /<Route\s[^>]*?path="([^"]*)"/.exec(text)
    return m ? [{ source: 'App.tsx', local: m[1], text, full: `/tms/${m[1]}` }] : []
  })
  const brokerage = routesOf('BrokeragePage.tsx', 'features/tms/brokerage/BrokeragePage.tsx', '/tms/brokerage/').filter((r) => !r.text.includes('<ReconciliationRoute'))
  const company = routesOf('CompanyTab.tsx', 'features/tms/brokerage/company/CompanyTab.tsx', '/tms/brokerage/company/')

  const table = [...tms, ...brokerage, ...company].filter((r) => !REDIRECT.test(r.text))

  it('finds the routes it is meant to check', () => {
    expect(tms.length).toBeGreaterThan(25)
    expect(brokerage.length).toBeGreaterThan(8)
    expect(company.length).toBeGreaterThan(6)
  })

  it.each(table.map((r) => [`${r.source} ${r.local || '(index)'}`, r] as const))('%s is wrapped exactly as the table says', (_name, r) => {
    const page: DormantPageKey | null = dormantPageForPath(r.full)
    const wrappedBy = /<DormantPage page="(\w+)"/.exec(r.text)?.[1] ?? null
    if (page) {
      expect(wrappedBy, `${r.full} needs a stage 2-4 model: wrap it in <DormantPage page="${page}">`).toBe(page)
      return
    }
    expect(wrappedBy, `${r.full} is not in the dormant table but is wrapped`).toBeNull()
    const key = r.source === 'App.tsx' ? r.local : r.source === 'BrokeragePage.tsx' ? `brokerage:${r.local}` : `company:${r.local}`
    expect(LIVE_ROUTES.has(key), `${r.full} is neither wrapped nor listed as a live production-model route`).toBe(true)
  })

  it('wraps the guards that sit outside the route table', () => {
    const brokerageSource = read('features/tms/brokerage/BrokeragePage.tsx')
    expect(brokerageSource).toMatch(/aljexReconciliation">\s*<AljexReconciliationPage/)
    expect(read('components/LoadRedirect.tsx')).toContain("modelAvailable('Shipment')")
  })
})
