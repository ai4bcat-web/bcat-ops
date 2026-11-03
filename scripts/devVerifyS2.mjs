#!/usr/bin/env node
/**
 * S2 visual verification against the DEV site (or `npm run dev` on localhost).
 *
 * Proves that no /tms/* page, dialog, drawer, toast or public page renders legacy dark
 * tokens, invisible text, unstyled tms-* classes or console/network errors, in light and
 * dark, and leaves screenshots under Docs/tms-build/screenshots/S2/ (plus index.txt).
 *
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS2.mjs      # before the push
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyS2.mjs
 *
 * Env:   DEV_VERIFY_UI_URL  site origin (default: the dev Amplify site); anything that is
 *                           not the dev site / localhost:5173 / 127.0.0.1:5173 is refused.
 *        CHROME_BIN         Chrome executable (default: macOS Google Chrome / google-chrome).
 * Flags: --only=<substr>    run only routes/states whose id contains <substr>
 *        --no-dark          skip the dark pass
 *        --inventory        run only the route-inventory completeness check (no network)
 *
 * A throwaway ADMIN identity (zz-s2-admin-<ts>@example.invalid) is created, its
 * password/tokens are never printed, and it is deleted (and proven gone) in `finally`.
 * Exit code is non-zero on any FAIL or any SKIPPED that is not in SKIP_ALLOWED.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, mintIdentity, deleteIdentity, routerAs } from './lib/devIdentity.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/

const SHOTS = resolve('Docs/tms-build/screenshots/S2')

/** Console / network problems that are tolerated. Each entry: { pattern: RegExp, reason }. */
const ALLOW_PROBLEMS = [
  // `vite` dev server only: the PWA manifest is generated at build time, so localhost serves index.html for it.
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
]

/** Routes/states that may legitimately be SKIPPED when dev has no data for them. */
const SKIP_ALLOWED = {
  '23-run': 'no workflow run may exist on dev',
  '31b-provider': 'no integration provider link may be listed on dev',
  '35-toast': 'no active customer link may exist to copy',
  '15a-invoice-detail': 'dev has no invoice yet (every order has invoiceId=null; Receivable lists none); generating one would mutate dev data',
  '15a-tabs': 'dev has no invoice yet',
  '16a-bill-detail': 'dev has no carrier bill yet (Payable lists none)',
  '16a-tabs': 'dev has no carrier bill yet',
  '14a-counter': 'Counter is only offered on a quote the customer has countered; none on dev',
  '18-expand': 'the dev factoring queue is empty (no row to expand)',
}

/**
 * tms-* classes that are hooks only (never styled): they carry no rules of their own.
 *  - tms-overdue / tms-due: state hooks
 *  - tms-theme-toggle: e2e/selector hook on a button already styled by tms-icon-btn
 *  - tms-dash: page hook on TmsPage (layout comes from TmsPage + the tms-dash-* descendants)
 *  - tms-probe-field: hook on a TmsField inside the Divisions probe row (TmsField styles it)
 *  - tms-public-head / tms-public-brand-name: structural wrappers inside TmsPublicFrame; they inherit from the frame
 */
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name']

// ───────────────────────────── route table ─────────────────────────────
// path placeholders: {shipment} {quote} {invoice} {bill} {carrier} {run} {academy} {provider} {view} {docview}
// pattern: the App.tsx / tab route this entry covers (":id"/":slug" normalise to ":p"); `light`/`dark` pass flags.
export const ROUTES = [
  { nn: '01', slug: 'dashboard', path: '/tms/dashboard', pattern: '/tms/dashboard', dark: true },
  { nn: '02', slug: 'shipments', path: '/tms/shipments', pattern: '/tms/shipments', dark: true, wideOk: true },
  { nn: '03', slug: 'shipments-view', path: '/tms/shipments/view/{view}', pattern: '/tms/shipments/view/:slug', wideOk: true },
  { nn: '04', slug: 'shipment-overview', path: '/tms/shipments/{shipment}', pattern: '/tms/shipments/:id', dark: true },
  { nn: '04a', slug: 'shipment-stops', path: '/tms/shipments/{shipment}?tab=stops', pattern: '/tms/shipments/:id?tab=stops' },
  { nn: '04b', slug: 'shipment-carrier', path: '/tms/shipments/{shipment}?tab=carrier', pattern: '/tms/shipments/:id?tab=carrier' },
  { nn: '04c', slug: 'shipment-tracking', path: '/tms/shipments/{shipment}?tab=tracking', pattern: '/tms/shipments/:id?tab=tracking', dark: true },
  { nn: '04d', slug: 'shipment-documents', path: '/tms/shipments/{shipment}?tab=documents', pattern: '/tms/shipments/:id?tab=documents', dark: true },
  { nn: '04e', slug: 'shipment-financials', path: '/tms/shipments/{shipment}?tab=financials', pattern: '/tms/shipments/:id?tab=financials' },
  { nn: '04f', slug: 'shipment-invoicing', path: '/tms/shipments/{shipment}?tab=invoicing', pattern: '/tms/shipments/:id?tab=invoicing' },
  { nn: '04g', slug: 'shipment-carrierpay', path: '/tms/shipments/{shipment}?tab=carrierPay', pattern: '/tms/shipments/:id?tab=carrierPay' },
  { nn: '04h', slug: 'shipment-history', path: '/tms/shipments/{shipment}?tab=history', pattern: '/tms/shipments/:id?tab=history' },
  { nn: '04j', slug: 'shipment-aiagent', path: '/tms/shipments/{shipment}?tab=aiAgent', pattern: '/tms/shipments/:id?tab=aiAgent' },
  { nn: '07', slug: 'dispatch', path: '/tms/dispatch', pattern: '/tms/dispatch', dark: true },
  { nn: '08', slug: 'tracking', path: '/tms/tracking?tab=tracking', pattern: '/tms/tracking', wideOk: true },
  { nn: '09', slug: 'tracking-inbox', path: '/tms/tracking?tab=inbox&shipment={shipment}', pattern: '/tms/tracking', dark: true, wideOk: true },
  { nn: '10', slug: 'tracking-links', path: '/tms/tracking/links', pattern: '/tms/tracking/links' },
  { nn: '11', slug: 'documents', path: '/tms/documents', pattern: '/tms/documents', dark: true },
  { nn: '11a', slug: 'documents-review', path: '/tms/documents/review', pattern: '/tms/documents/review' },
  { nn: '11b', slug: 'documents-view', path: '/tms/documents/view/{docview}', pattern: '/tms/documents/view/:slug' },
  { nn: '12', slug: 'check-calls', path: '/tms/check-calls', pattern: '/tms/check-calls' },
  { nn: '13', slug: 'rates', path: '/tms/rates', pattern: '/tms/rates', dark: true },
  { nn: '13a', slug: 'rates-lanes', path: '/tms/rates/lanes', pattern: '/tms/rates/lanes' },
  { nn: '14', slug: 'rates-detail', path: '/tms/rates/{quote}', pattern: '/tms/rates/:id', dark: true },
  { nn: '14n', slug: 'rates-new', path: '/tms/rates/new', pattern: '/tms/rates/new', dark: true },
  { nn: '15', slug: 'invoicing', path: '/tms/invoicing', pattern: '/tms/invoicing', dark: true },
  { nn: '15a', slug: 'invoice-detail', path: '/tms/invoicing/invoices/{invoice}', pattern: '/tms/invoicing/invoices/:id', dark: true },
  { nn: '16', slug: 'payable', path: '/tms/invoicing/payable', pattern: '/tms/invoicing/payable', dark: true },
  { nn: '16a', slug: 'bill-detail', path: '/tms/invoicing/payable/bills/{bill}', pattern: '/tms/invoicing/payable/bills/:id' },
  { nn: '17', slug: 'carriers', path: '/tms/carriers', pattern: '/tms/carriers', dark: true },
  { nn: '17b', slug: 'carrier-drawer', path: '/tms/carriers/{carrier}', pattern: '/tms/carriers/:id', dark: true },
  { nn: '18', slug: 'factors', path: '/tms/factors', pattern: '/tms/factors', dark: true },
  { nn: '19', slug: 'customers', path: '/tms/customers', pattern: '/tms/customers', dark: true },
  { nn: '20', slug: 'locations', path: '/tms/locations', pattern: '/tms/locations' },
  { nn: '21', slug: 'vendors', path: '/tms/vendors', pattern: '/tms/vendors' },
  { nn: '22', slug: 'workflows', path: '/tms/workflows', pattern: '/tms/workflows' },
  { nn: '23', slug: 'run', path: '/tms/workflows/runs/{run}', pattern: '/tms/workflows/runs/:id', dark: true },
  { nn: '24', slug: 'academy', path: '/tms/academy', pattern: '/tms/academy' },
  { nn: '24a', slug: 'academy-article', path: '/tms/academy/{academy}', pattern: '/tms/academy/:slug', dark: true },
  { nn: '25', slug: 'brokerage', path: '/tms/brokerage', pattern: '/tms/brokerage', dark: true },
  { nn: '26', slug: 'users', path: '/tms/brokerage/users', pattern: '/tms/brokerage/users', dark: true },
  { nn: '27', slug: 'commissions', path: '/tms/brokerage/commissions', pattern: '/tms/brokerage/commissions' },
  { nn: '28', slug: 'reports', path: '/tms/brokerage/reports', pattern: '/tms/brokerage/reports', dark: true },
  { nn: '29', slug: 'audit', path: '/tms/brokerage/audit', pattern: '/tms/brokerage/audit' },
  { nn: '30', slug: 'divisions', path: '/tms/brokerage/divisions', pattern: '/tms/brokerage/divisions' },
  { nn: '30b', slug: 'views', path: '/tms/brokerage/views', pattern: '/tms/brokerage/views' },
  { nn: '31', slug: 'integrations', path: '/tms/brokerage/integrations', pattern: '/tms/brokerage/integrations' },
  { nn: '31b', slug: 'provider', path: '/tms/brokerage/integrations/{provider}', pattern: '/tms/brokerage/integrations/:provider' },
  { nn: '32', slug: 'ai-agents', path: '/tms/brokerage/ai-agents', pattern: '/tms/brokerage/ai-agents' },
  { nn: '33a', slug: 'company-company', path: '/tms/brokerage/company/company', pattern: '/tms/brokerage/company/company' },
  { nn: '33b', slug: 'company-billing', path: '/tms/brokerage/company/billing', pattern: '/tms/brokerage/company/billing' },
  { nn: '33c', slug: 'company-branding', path: '/tms/brokerage/company/branding', pattern: '/tms/brokerage/company/branding' },
  { nn: '33d', slug: 'company-notifications', path: '/tms/brokerage/company/notifications', pattern: '/tms/brokerage/company/notifications' },
  { nn: '33e', slug: 'company-import', path: '/tms/brokerage/company/import', pattern: '/tms/brokerage/company/import' },
  { nn: '33f', slug: 'company-aljex-import', path: '/tms/brokerage/company/aljex-import', pattern: '/tms/brokerage/company/aljex-import' },
  { nn: '33g', slug: 'company-account', path: '/tms/brokerage/company/account', pattern: '/tms/brokerage/company/account' },
  { nn: '34', slug: 'demo', path: '/tms/brokerage/demo', pattern: '/tms/brokerage/demo' },
]

// ───────────────────────────── states ─────────────────────────────
// steps: { click: string | {text|pattern, selector} } | { key: 'Escape' } ; `tabs` = loop every [role=tab].
const OVERLAY = '[role="dialog"], [role="menu"], [role="alertdialog"], [data-radix-popper-content-wrapper], .tms-drawer, .tms-portal'
const FIRST_ROW = 'tbody tr, [role="row"][data-id], [data-shipment-id], [data-testid$="-row"]'
const NEW_BTN = { pattern: '^(\\+\\s*)?(New|Add|Create)\\b' }
export const STATES = [
  { id: '02a-menu', nn: '02a', slug: 'board-row-menu', path: '/tms/shipments', dark: true, steps: [{ click: { selector: 'tbody button[aria-label="Shipment actions"]', real: true } }], probe: 'menu' },
  { id: '02a-columns', nn: '02a', slug: 'board-columns', path: '/tms/shipments', dark: true, steps: [{ click: { label: '^Manage column templates' } }] },
  { id: '02a-iconkey', nn: '02a', slug: 'board-icon-key', path: '/tms/shipments', steps: [{ click: { pattern: '^Icon key' } }] },
  { id: '02a-filterset', nn: '02a', slug: 'board-filter-set', path: '/tms/shipments', steps: [{ click: { label: '^Save as view' } }] },
  { id: '05-drawer', nn: '05', slug: 'board-drawer', path: '/tms/shipments', dark: true, steps: [{ click: { selector: FIRST_ROW } }] },
  { id: '06-new', nn: '06', slug: 'new-shipment', path: '/tms/shipments', dark: true, steps: [{ click: { pattern: '^(\\+\\s*)?Create shipment' } }] },
  { id: '12-tabs', nn: '12', slug: 'check-calls-tabs', path: '/tms/check-calls', tabs: true },
  { id: '08-tabs', nn: '08', slug: 'tracking-tabs', path: '/tms/tracking?tab=tracking', tabs: true },
  { id: '15-tabs', nn: '15', slug: 'invoicing-tabs', path: '/tms/invoicing', tabs: true, dark: true },
  { id: '16-tabs', nn: '16', slug: 'payable-tabs', path: '/tms/invoicing/payable', tabs: true },
  { id: '15a-tabs', nn: '15a', slug: 'invoice-tabs', path: '/tms/invoicing/invoices/{invoice}', tabs: true },
  { id: '16a-tabs', nn: '16a', slug: 'bill-tabs', path: '/tms/invoicing/payable/bills/{bill}', tabs: true },
  { id: '17-tabs', nn: '17', slug: 'carrier-drawer-tabs', path: '/tms/carriers/{carrier}', tabs: true },
  { id: '17a-add', nn: '17a', slug: 'add-carrier', path: '/tms/carriers', steps: [{ click: { pattern: '^(\\+\\s*)?(Add )?Carrier$' } }] },
  // The factoring queue has no row dialog: a row expands in place via its aria-expanded button.
  { id: '18-expand', nn: '18', slug: 'factor-row-expanded', path: '/tms/factors', dark: true, steps: [{ click: { selector: 'tbody button[aria-expanded="false"]' } }], expect: 'tbody button[aria-expanded="true"]' },
  { id: '19-profile', nn: '19', slug: 'customer-profile', path: '/tms/customers', steps: [{ click: { selector: FIRST_ROW } }], tabsInOverlay: true },
  { id: '20-detail', nn: '20', slug: 'location-dialog', path: '/tms/locations', steps: [{ click: { selector: FIRST_ROW } }] },
  { id: '21-detail', nn: '21', slug: 'vendor-dialog', path: '/tms/vendors', steps: [{ click: { selector: FIRST_ROW } }] },
  { id: '14a-send', nn: '14a', slug: 'quote-send', path: '/tms/rates/{quote}', steps: [{ click: { label: '^Send the quote' } }] },
  { id: '14a-counter', nn: '14a', slug: 'quote-counter', path: '/tms/rates/{quote}', steps: [{ click: { label: '^Counter the quote' } }] },
  { id: '30-dialog', nn: '30', slug: 'divisions-dialog', path: '/tms/brokerage/divisions', steps: [{ click: NEW_BTN }] },
  { id: '28-tabs', nn: '28', slug: 'reports-tabs', path: '/tms/brokerage/reports', tabs: true, dark: true },
  { id: '32-tabs', nn: '32', slug: 'ai-agents-tabs', path: '/tms/brokerage/ai-agents', tabs: true },
]

// ───────────────────────────── route inventory ─────────────────────────────
const normalise = (p) => p.replace(/:\w+/g, ':p').replace(/\/+$/, '')

/** Every /tms route pattern and tab the source declares; the script must have an entry for each. */
export async function requiredPatterns(root = process.cwd()) {
  const app = await readFile(join(root, 'src/App.tsx'), 'utf8')
  const start = app.indexOf('<Route path="/tms"')
  if (start < 0) throw new Error('src/App.tsx has no <Route path="/tms"> block')
  const end = app.indexOf('</Route>', start)
  const block = app.slice(start, end)
  const found = new Set()
  for (const m of block.matchAll(/<Route\s+path="([^"]+)"/g)) {
    const path = m[1]
    if (path === '/tms') continue
    if (path === 'brokerage/*') continue
    found.add(normalise(`/tms/${path}`))
  }
  const brokerage = await readFile(join(root, 'src/features/tms/brokerage/BrokeragePage.tsx'), 'utf8')
  const tabs = brokerage.slice(brokerage.indexOf('const TABS'), brokerage.indexOf(']\n', brokerage.indexOf('const TABS')))
  for (const m of tabs.matchAll(/path:\s*'([^']*)'/g)) found.add(normalise(m[1] ? `/tms/brokerage/${m[1]}` : '/tms/brokerage'))
  found.delete('/tms/brokerage/company') // expanded by CompanyTab below
  const company = await readFile(join(root, 'src/features/tms/brokerage/company/CompanyTab.tsx'), 'utf8')
  const ctabs = company.slice(company.indexOf('const TABS'), company.indexOf(']', company.indexOf('const TABS')))
  for (const m of ctabs.matchAll(/key:\s*'([^']+)'/g)) found.add(`/tms/brokerage/company/${m[1]}`)
  found.add('/tms/brokerage/integrations/:p') // nested provider route inside IntegrationsIndex
  const detail = await readFile(join(root, 'src/features/shipments/components/detailTabs.ts'), 'utf8')
  const keys = detail.slice(detail.indexOf('DETAIL_TAB_KEYS = ['), detail.indexOf('] as const'))
  for (const m of keys.matchAll(/'([A-Za-z]+)'/g)) {
    if (m[1] !== 'overview') found.add(`/tms/shipments/:p?tab=${m[1]}`)
  }
  return [...found].sort()
}

export function missingFromRoutes(required, routes = ROUTES) {
  const have = new Set(routes.map((r) => normalise(r.pattern)))
  return required.filter((p) => !have.has(p))
}

// ───────────────────────────── in-page audit ─────────────────────────────
/**
 * Runs inside the page (serialised with toString). Returns offenders per check.
 * opts: { theme, wideOk, hookClasses }
 */
export function auditInPage(opts) {
  const BANNED = new Set([
    'rgb(244, 197, 12)', 'rgb(255, 210, 34)', // old yellow
    'rgb(30, 168, 243)', 'rgb(3, 105, 161)', // legacy brand blue
    'rgb(14, 17, 22)', 'rgb(11, 18, 32)', 'rgb(16, 35, 70)', // #0e1116 header, dark navy, tooltip
  ])
  const BANNED_SURFACE = new Set(['rgb(244, 247, 251)', 'rgb(244, 246, 248)'])
  const BANNED_BORDER = new Set(['rgb(226, 232, 240)'])
  // gm-style/iframe: third-party; recharts_measurement_span: library text-measuring node; [data-user-color]: user-chosen data colour swatch (not chrome)
  const EXCLUDE = '.gm-style, iframe, [data-tms-paper], .tms-chart-tip, [data-sonner-toast] [role="tooltip"], .tms-count-badge, #recharts_measurement_span, [data-user-color]'
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return { r, g, b, a }
  }
  const norm = (c) => (c ? `rgb(${c.r}, ${c.g}, ${c.b})` : '')
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''}`
  }
  const visible = (el, cs, rect) => rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01
  const out = { legacy: [], surface: [], invisible: [], unstyled: [], currentColor: { count: 0, samples: [] }, layout: [] }
  const push = (list, item) => { if (list.length < 3) list.push(item) }

  // token probes
  // Tokens are declared on .tms-shell / .tms-portal (never :root), so the probe must live inside one.
  const scope = document.querySelector('.tms-shell, .tms-portal') ?? document.body
  const probe = document.createElement('div')
  scope.appendChild(probe)
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--tms-bg)'
  const tokenBg = parse(getComputedStyle(probe).backgroundColor)
  probe.remove()

  const all = [...document.body.querySelectorAll('*')]
  const classes = new Set()
  let sampled = 0
  for (const el of all) {
    if (el.closest(EXCLUDE)) continue
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if (!visible(el, cs, rect)) continue
    if (typeof el.className === 'string') for (const c of el.classList) if (c.startsWith('tms-')) classes.add(c)
    const isSvgPart = el instanceof SVGElement
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    const checks = []
    if (hasText) checks.push(['color', cs.color])
    const bg = parse(cs.backgroundColor)
    if (bg && bg.a > 0.5) checks.push(['background-color', cs.backgroundColor])
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (parseFloat(cs[`border-${side}-width`]) > 0 && cs[`border-${side}-style`] !== 'none') checks.push([`border-${side}-color`, cs[`border-${side}-color`], 'border'])
    }
    if (isSvgPart) { checks.push(['fill', cs.fill]); checks.push(['stroke', cs.stroke]) }
    for (const [prop, value, kind] of checks) {
      const key = norm(parse(value))
      if (!key) continue
      if (BANNED.has(key)) push(out.legacy, `${describe(el)} ${prop} ${key}`)
      else if (prop === 'background-color' && BANNED_SURFACE.has(key)) push(out.legacy, `${describe(el)} surface ${key}`)
      else if (kind === 'border' && BANNED_BORDER.has(key)) push(out.legacy, `${describe(el)} ${prop} ${key}`)
    }
    // dark-on-light / light-on-dark surfaces
    if (bg && bg.a >= 0.9 && rect.width * rect.height >= 1600) {
      const l = lum(bg)
      if (opts.theme === 'light' && l < 0.12) push(out.surface, `${describe(el)} dark surface ${norm(bg)} in light theme`)
      if (opts.theme === 'dark' && l > 0.85) push(out.surface, `${describe(el)} light surface ${norm(bg)} in dark theme`)
    }
    // invisible text
    if (hasText && sampled < 400 && !isSvgPart) {
      sampled++
      let bgc = null
      let image = false
      for (let p = el; p; p = p.parentElement) {
        const pcs = getComputedStyle(p)
        if (pcs.backgroundImage !== 'none') { image = true; break }
        const c = parse(pcs.backgroundColor)
        if (c && c.a >= 0.95) { bgc = c; break }
      }
      if (!image) {
        const fg = parse(cs.color)
        const b = bgc ?? tokenBg
        if (fg && b && fg.a > 0.3) {
          const l1 = lum(fg); const l2 = lum(b)
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
          if (ratio < 1.5) push(out.invisible, `${describe(el)} "${el.textContent.trim().slice(0, 30)}" ${norm(fg)} on ${norm(b)} (${ratio.toFixed(2)})`)
        }
      }
    }
    // currentColor borders
    if (!el.matches('.tms-btn, .tms-badge, .tms-chip') && parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && cs.borderTopColor === cs.color) {
      out.currentColor.count++
      push(out.currentColor.samples, describe(el))
    }
  }

  // unstyled tms-* classes
  const styled = new Set()
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText) for (const m of r.selectorText.matchAll(/\.(tms-[\w-]+)/g)) styled.add(m[1])
      if (r.cssRules) walk(r.cssRules)
    }
  }
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules) } catch { /* cross-origin sheet */ } }
  for (const c of classes) if (!styled.has(c) && !opts.hookClasses.includes(c)) out.unstyled.push(c)

  // layout
  const html = document.documentElement
  // light is the absence of the attribute (tmsTheme.apply removes it); only dark sets it
  const attr = html.getAttribute('data-tms-theme')
  if ((attr === 'dark' ? 'dark' : 'light') !== opts.theme || (attr != null && attr !== 'dark')) out.layout.push(`html[data-tms-theme]=${attr} expected ${opts.theme === 'dark' ? 'dark' : 'absent'}`)
  const main = document.querySelector('.tms-main')
  if (!main) out.layout.push('.tms-main missing')
  else if (!opts.wideOk && main.scrollWidth > main.clientWidth + 2) out.layout.push(`.tms-main overflows horizontally (${main.scrollWidth} > ${main.clientWidth})`)
  else if (opts.wideOk && html.scrollWidth > html.clientWidth + 2) out.layout.push(`page overflows horizontally (${html.scrollWidth} > ${html.clientWidth})`)
  const shell = document.querySelector('.tms-shell')
  if (shell && tokenBg && norm(parse(getComputedStyle(shell).backgroundColor)) !== norm(tokenBg)) out.layout.push(`.tms-shell background ${getComputedStyle(shell).backgroundColor} != --tms-bg ${norm(tokenBg)}`)
  return out
}

export function auditFailures(a) {
  const f = []
  for (const x of a.legacy) f.push(`legacy token: ${x}`)
  for (const x of a.surface) f.push(`surface: ${x}`)
  for (const x of a.invisible) f.push(`invisible text: ${x}`)
  if (a.unstyled.length) f.push(`unstyled classes: ${a.unstyled.slice(0, 3).join(', ')}${a.unstyled.length > 3 ? ` (+${a.unstyled.length - 3})` : ''}`)
  if (a.currentColor.count > 3) f.push(`currentColor borders: ${a.currentColor.count} (${a.currentColor.samples.join(', ')})`)
  for (const x of a.layout) f.push(`layout: ${x}`)
  return f
}

/**
 * Legacy-colour check for public pages (no .tms-main shell). Injected into the page by source,
 * so it receives auditInPage as a parameter (page-side functions cannot see this module's scope).
 */
export function publicAuditInPage(opts, auditInPage) {
  const a = auditInPage({ ...opts, theme: 'light' })
  const root = document.querySelector('.tms-public')
  const rootBg = root ? getComputedStyle(root).backgroundColor : ''
  const card = document.querySelector('.tms-public-card')
  const cardBg = card ? getComputedStyle(card).backgroundColor : ''
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:-9999px;background:var(--tms-bg)'
  ;(root ?? document.body).appendChild(probe)
  const token = getComputedStyle(probe).backgroundColor
  probe.remove()
  return { ...a, layout: [], publicRoot: !!root, rootBg, cardBg, tokenBg: token, signIn: /\/login|\/sign-?in/.test(location.pathname) }
}

// ───────────────────────────── runner ─────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a === `--${name}`) != null
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const report = []
const written = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(7)}${name}${detail ? ` — ${detail}` : ''}`)
}
const allowedProblem = (text) => ALLOW_PROBLEMS.some((a) => a.pattern.test(text))

function fill(path, data) {
  let missing = null
  const url = path.replace(/\{(\w+)\}/g, (_, k) => {
    if (!data[k]) missing = k
    return data[k] ?? ''
  })
  return { url, missing }
}

async function waitLoaded(b) {
  await b.poll(() => b.evaluate(`(() => {
    const main = document.querySelector('.tms-main');
    if (!main || !main.children.length || !main.innerText.trim()) return false;
    return !/(^|\\s)Loading(…|\\.\\.\\.)?(\\s|$)/.test(main.innerText);
  })()`), 'content without a Loading spinner', 30_000)
  await pause(300)
}

async function audit(b, theme, wideOk) {
  return b.evaluate(`(${auditInPage})(${JSON.stringify({ theme, wideOk: !!wideOk, hookClasses: HOOK_CLASSES })})`)
}

async function shot(b, name, theme, nn, slug) {
  const file = join(SHOTS, `${nn}-${slug}-${theme}.png`)
  await b.screenshot(file, { clipToContent: true })
  written.push(file)
}

/** Audit the current page; problems()/audit offenders decide PASS/FAIL; screenshot always. */
async function judge(b, id, theme, { nn, slug, wideOk, extra = [] }) {
  const problems = b.problems()
  const probs = [
    ...problems.exceptions.map((x) => `exception: ${x}`),
    ...problems.consoleErrors.map((x) => `console error: ${x}`),
    ...problems.httpErrors.map((x) => `HTTP ${x}`),
    ...problems.failedRequests.map((x) => `request failed: ${x}`),
  ].filter((p) => !allowedProblem(p))
  const failures = [...extra, ...probs.slice(0, 3), ...auditFailures(await audit(b, theme, wideOk)).slice(0, 3)]
  await shot(b, id, theme, nn, slug).catch((e) => failures.push(`screenshot failed: ${e.message}`))
  if (failures.length) line('FAIL', `${id} ${theme}`, failures.slice(0, 3).join(' | '))
  else line('PASS', `${id} ${theme}`)
  return failures.length === 0
}

function skipLine(id, theme, why) {
  if (SKIP_ALLOWED[id]) line('SKIPPED', `${id} ${theme}`, `(allowed: ${SKIP_ALLOWED[id]}) ${why}`)
  else line('SKIPPED', `${id} ${theme}`, `(no data: ${why})`)
}

const matches = (id) => !only || id.includes(only)

async function discover(b, path, regex) {
  await b.navigate(path)
  await waitLoaded(b).catch(() => {})
  await pause(1500)
  return b.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(regex)});
    for (const a of document.querySelectorAll('a[href]')) { const m = re.exec(a.getAttribute('href')); if (m) return decodeURIComponent(m[1]); }
    return null;
  })()`)
}

async function discoverData(b, ship) {
  const data = {}
  const state = await ship('GET_DEMO_STATE', {}).catch(() => ({ records: [] }))
  const rec = (kind, key) => state.records?.find((r) => r.kind === kind && (!key || r.demoKey === key))
  data.shipment = (rec('SHIPMENT', 'shipment.open.assigned') ?? rec('SHIPMENT'))?.recordId
  data.transit = (rec('SHIPMENT', 'shipment.intransit') ?? rec('SHIPMENT'))?.recordId
  data.quote = rec('QUOTE')?.recordId
  // Carrier detail is keyed by carrierId, which the demo load-carrier on the in-transit shipment carries.
  const transitBundle = data.transit ? await ship('GET_SHIPMENT_BUNDLE', { shipmentId: data.transit }).catch(() => null) : null
  data.carrier = transitBundle?.loadCarriers?.find((c) => c.carrierId)?.carrierId ?? rec('CARRIER')?.recordId
  const list = [
    ['shipment', '/tms/shipments', '^/tms/shipments/(?!view/)([^/?#]+)'],
    ['view', '/tms/shipments', '^/tms/shipments/view/([^/?#]+)'],
    ['docview', '/tms/documents', '^/tms/documents/view/([^/?#]+)'],
    ['quote', '/tms/rates', '^/tms/rates/(?!lanes|new)([^/?#]+)'],
    ['invoice', '/tms/invoicing', '^/tms/invoicing/invoices/([^/?#]+)'],
    ['bill', '/tms/invoicing/payable', '^/tms/invoicing/payable/bills/([^/?#]+)'],
    ['run', '/tms/workflows', '^/tms/workflows/runs/([^/?#]+)'],
    ['academy', '/tms/academy', '^/tms/academy/([^/?#]+)'],
    ['provider', '/tms/brokerage/integrations', '^/tms/brokerage/integrations/([^/?#]+)'],
  ]
  for (const [key, path, regex] of list) {
    if (data[key]) continue
    data[key] = await discover(b, path, regex).catch(() => null)
  }
  data.docview ??= data.view // saved views are shared by the board and documents workstations
  return { data, state, rec }
}

async function setTheme(b, theme) {
  const current = await b.evaluate(`document.documentElement.getAttribute('data-tms-theme') === 'dark' ? 'dark' : 'light'`)
  if (current === theme) return
  const label = theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme'
  await b.click({ selector: `[aria-label="${label}"]` })
  await b.poll(() => b.evaluate(`(document.documentElement.getAttribute('data-tms-theme') === 'dark' ? 'dark' : 'light') === ${JSON.stringify(theme)}`), `theme ${theme}`, 10_000)
}

async function runRoute(b, route, data, theme) {
  const id = `${route.nn}-${route.slug}`
  if (!matches(id)) return
  const { url, missing } = fill(route.path, data)
  if (missing) { skipLine(id, theme, missing); return }
  await b.navigate(url)
  try { await waitLoaded(b) } catch (e) {
    await judge(b, id, theme, { nn: route.nn, slug: route.slug, wideOk: route.wideOk, extra: [e.message] })
    return
  }
  b.mark()
  await pause(500)
  const extra = []
  if (route.slug === 'tracking-inbox') extra.push(...await inboxAsserts(b))
  await judge(b, id, theme, { nn: route.nn, slug: route.slug, wideOk: route.wideOk, extra })
}

const INBOX_TESTIDS = ['inbox-chat-header', 'inbox-quick-actions', 'inbox-info-panel', 'inbox-status-timeline', 'inbox-driver-card']
async function inboxAsserts(b) {
  // Conversations arrive after the list (one message read per shipment): wait for the framed thread.
  await b.waitFor('[data-testid="inbox-chat-header"]', 45_000).catch(() => {})
  await pause(500)
  const missing = await b.evaluate(`${JSON.stringify(INBOX_TESTIDS)}.filter((t) => !document.querySelector('[data-testid="' + t + '"]'))`)
  return missing.length ? [`inbox elements missing: ${missing.join(', ')}`] : []
}

async function closeOverlays(b) {
  for (let i = 0; i < 3; i++) {
    const open = await b.evaluate(`!!document.querySelector(${JSON.stringify(OVERLAY)}) && [...document.querySelectorAll(${JSON.stringify(OVERLAY)})].some((e) => e.getBoundingClientRect().width > 0)`)
    if (!open) return
    await b.press('Escape')
    await pause(300)
  }
}

async function runState(b, st, data, theme) {
  if (!matches(st.id)) return
  const { url, missing } = fill(st.path, data)
  if (missing) { skipLine(st.id, theme, missing); return }
  await b.navigate(url)
  try { await waitLoaded(b) } catch (e) { line('FAIL', `${st.id} ${theme}`, e.message); return }
  await pause(800)
  if (st.tabs) {
    const labels = await b.evaluate(`[...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()).filter(Boolean)`)
    if (!labels.length) { skipLine(st.id, theme, 'no [role=tab] on page'); return }
    for (const [i, label] of labels.entries()) {
      await b.click({ selector: '[role="tab"]', text: label }).catch(() => {})
      await pause(1200)
      b.mark()
      await pause(300)
      const slug = `${st.slug}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || i}`
      await judge(b, `${st.id}:${label}`, theme, { nn: st.nn, slug })
    }
    return
  }
  try {
    for (const step of st.steps) {
      if (step.key) { await b.press(step.key); continue }
      // The trigger (row, menu, button) often renders after the page's first content: retry for a while.
      await b.poll(() => b.click(step.click).then(() => true, () => false), `trigger ${JSON.stringify(step.click)}`, 20_000)
    }
  } catch {
    skipLine(st.id, theme, 'trigger not found')
    return
  }
  const opened = await b.poll(() => b.evaluate(`!!document.querySelector(${JSON.stringify(st.expect ?? OVERLAY)})`), `${st.id} overlay`, 8000).catch(() => false)
  if (!opened) { line('FAIL', `${st.id} ${theme}`, 'trigger clicked but nothing opened'); return }
  await pause(700)
  b.mark()
  await pause(300)
  const extra = []
  if (st.probe === 'menu') extra.push(...await menuProbe(b))
  await judge(b, st.id, theme, { nn: st.nn, slug: st.slug, extra })
  if (st.tabsInOverlay) {
    const names = await b.evaluate(`[...document.querySelectorAll('[role="dialog"] [role="tab"]')].map((t) => t.textContent.trim()).filter(Boolean)`)
    for (const label of names) {
      await b.click({ selector: '[role="dialog"] [role="tab"]', text: label }).catch(() => {})
      await pause(1000)
      b.mark()
      await judge(b, `${st.id}:${label}`, theme, { nn: st.nn, slug: `${st.slug}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` })
    }
  }
  await closeOverlays(b)
}

/** Bridge probe: menu background == --tms-bg-elevated; a checked Checkbox/Switch fill == --tms-primary. */
async function menuProbe(b) {
  return b.evaluate(`(() => {
    const out = [];
    const scope = (document.querySelector('[role="menu"]')?.closest('.tms-portal, .tms-shell')) ?? document.querySelector('.tms-shell, .tms-portal') ?? document.body; const probe = (v) => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:-9999px;background:var(' + v + ')'; scope.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
    const menu = document.querySelector('[role="menu"]');
    if (menu && getComputedStyle(menu).backgroundColor !== probe('--tms-bg-elevated')) out.push('menu background ' + getComputedStyle(menu).backgroundColor + ' != --tms-bg-elevated ' + probe('--tms-bg-elevated'));
    const checked = document.querySelector('[role="checkbox"][data-state="checked"], [role="switch"][data-state="checked"]');
    if (checked && getComputedStyle(checked).backgroundColor !== probe('--tms-primary')) out.push('checked control fill ' + getComputedStyle(checked).backgroundColor + ' != --tms-primary ' + probe('--tms-primary'));
    return out;
  })()`)
}

async function inboxPanelPersistence(b, data) {
  const id = '09-inbox-info-persist'
  if (!matches(id)) return
  if (!data.shipment) { skipLine(id, 'light', 'shipment'); return }
  await b.navigate(`/tms/tracking?tab=inbox&shipment=${data.shipment}`)
  try { await waitLoaded(b) } catch (e) { line('FAIL', `${id} light`, e.message); return }
  await b.waitFor('[data-testid="inbox-info-panel"]', 45_000).catch(() => {})
  const hasPanel = await b.evaluate(`!!document.querySelector('[data-testid="inbox-info-panel"]')`)
  if (!hasPanel) { line('FAIL', `${id} light`, 'inbox-info-panel absent'); return }
  try { await b.click({ selector: '[data-testid="inbox-info-panel"] button[aria-label^="Close"], [data-testid="inbox-info-panel"] button[aria-label="×"]' }) } catch {
    line('FAIL', `${id} light`, 'info panel has no Close button'); return
  }
  await pause(600)
  const gone = await b.evaluate(`!document.querySelector('[data-testid="inbox-info-panel"]')`)
  await b.reload()
  await waitLoaded(b).catch(() => {})
  await pause(800)
  const stillGone = await b.evaluate(`!document.querySelector('[data-testid="inbox-info-panel"]')`)
  b.mark()
  await shot(b, id, 'light', '09', 'tracking-inbox-info-closed')
  // restore the default (open) state for later runs
  await b.evaluate(`localStorage.removeItem('tms-inbox-info')`)
  if (gone && stillGone) line('PASS', `${id} light`)
  else line('FAIL', `${id} light`, `closed=${gone} afterReload=${stillGone}`)
}

async function toastProbe(b, theme) {
  const id = '35-toast'
  if (!matches(id)) return
  await b.navigate('/tms/tracking/links')
  try { await waitLoaded(b) } catch (e) { line('FAIL', `${id} ${theme}`, e.message); return }
  await pause(1000)
  await b.grantClipboard()
  try { await b.click({ pattern: '^Copy', selector: 'button' }) } catch { skipLine(id, theme, 'no active link to copy'); return }
  const shown = await b.poll(() => b.evaluate(`!!document.querySelector('[data-sonner-toast]')`), 'toast', 5000).catch(() => false)
  if (!shown) { line('FAIL', `${id} ${theme}`, 'no [data-sonner-toast] after Copy'); return }
  const result = await b.evaluate(`(() => {
    const t = document.querySelector('[data-sonner-toast]');
    const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:-9999px;background:var(--tms-card)'; (t.closest('.tms-portal') ?? document.body).appendChild(d);
    const card = getComputedStyle(d).backgroundColor; d.remove();
    return { bg: getComputedStyle(t).backgroundColor, card, portal: !!t.closest('.tms-portal') };
  })()`)
  const extra = []
  if (result.bg !== result.card) extra.push(`toast background ${result.bg} != --tms-card ${result.card}`)
  if (!result.portal) extra.push('toast is not inside .tms-portal')
  await shot(b, id, theme, '35', 'toast')
  if (extra.length) line('FAIL', `${id} ${theme}`, extra.join(' | '))
  else line('PASS', `${id} ${theme}`)
}

async function themePass(b) {
  // Observe `document` (subtree): at new-document time <html> does not exist yet, so observing documentElement throws.
  const pre = 'window.__s2Theme=null;new MutationObserver(function(_,o){var v=document.documentElement.getAttribute("data-tms-theme");if(v&&!window.__s2Theme){window.__s2Theme={value:v,readyState:document.readyState};o.disconnect()}}).observe(document,{attributes:true,subtree:true,attributeFilter:["data-tms-theme"]});'
  await b.addInitScript(pre)
  await setTheme(b, 'dark')
  await b.navigate('/tms/dashboard')
  await waitLoaded(b).catch(() => {})
  await b.reload()
  await waitLoaded(b).catch(() => {})
  const first = await b.evaluate('window.__s2Theme')
  const now = await b.evaluate(`document.documentElement.getAttribute('data-tms-theme')`)
  if (first?.value === 'dark' && first.readyState === 'loading' && now === 'dark') line('PASS', 'theme dark applied before first paint and survives reload', `first set while document ${first.readyState}`)
  else line('FAIL', 'theme dark applied before first paint and survives reload', `first=${JSON.stringify(first)} now=${now}`)
}

async function publicPages(origin, tokens) {
  const b = await launchBrowser({ origin, profilePrefix: 'bcat-s2-pub-', purpose: 'S2 verification' })
  try {
    const pages = [
      { nn: 'P1', slug: 'track-customer', path: tokens.customer && `/track/s/${tokens.customer}`, mobile: true },
      { nn: 'P2', slug: 'track-carrier', path: tokens.ping && `/track/l/${tokens.ping}`, mobile: true },
      { nn: 'P3', slug: 'track-upload', path: tokens.upload && `/track/u/${tokens.upload}`, mobile: true },
      { nn: 'P4', slug: 'rate-con', path: tokens.rateCon && `/sign/rate-con/${tokens.rateCon}`, mobile: true, loaded: true },
      { nn: 'P4i', slug: 'rate-con-inactive', path: `/sign/rate-con/s2-inactive-${Date.now()}`, mobile: true },
      { nn: 'P5i', slug: 'quote-inactive', path: `/quote/s2-inactive-${Date.now()}`, mobile: false },
    ]
    for (const p of pages) {
      const id = `${p.nn}-${p.slug}`
      if (!matches(id)) continue
      if (!p.path) { skipLine(id, 'light', 'no token could be minted'); continue }
      for (const mobile of p.mobile ? [false, true] : [false]) {
        if (mobile) await b.setViewport(390, 844, 1); else await b.setViewport(1600, 1000, 1)
        const tag = mobile ? 'mobile' : 'light'
        await b.navigate(p.path)
        await b.poll(() => b.evaluate(`!!document.querySelector('.tms-public')`), '.tms-public', 20_000).catch(() => {})
        await pause(1500)
        b.mark()
        await pause(300)
        const res = await b.evaluate(`((auditInPage) => (${publicAuditInPage})(${JSON.stringify({ wideOk: true, hookClasses: HOOK_CLASSES })}, auditInPage))(${auditInPage})`)
        const fails = []
        if (!res.publicRoot) fails.push('root .tms-public missing')
        if (res.signIn) fails.push('redirected to sign-in')
        if (res.rootBg !== res.tokenBg) fails.push(`.tms-public background ${res.rootBg} != --tms-bg ${res.tokenBg}`)
        if (res.cardBg === 'rgba(0, 0, 0, 0)') fails.push('.tms-public-card has no surface background (frame rules not matching)')
        fails.push(...auditFailures({ ...res, unstyled: res.unstyled }).filter((f) => !f.startsWith('layout')))
        const problems = b.problems()
        fails.push(...[
          ...problems.exceptions, ...problems.consoleErrors.map((x) => `console: ${x}`),
          ...problems.failedRequests.map((x) => `request failed: ${x}`),
          // inactive-link pages legitimately answer 4xx from the public Lambda
          ...(p.loaded || /^P[123]$/.test(p.nn) ? problems.httpErrors.map((x) => `HTTP ${x}`) : []),
        ].filter((x) => !allowedProblem(x)))
        const file = join(SHOTS, `${p.nn}-${p.slug}-${tag}.png`)
        await b.screenshot(file, { clipToContent: true }).then(() => written.push(file)).catch((e) => fails.push(`screenshot failed: ${e.message}`))
        if (fails.length) line('FAIL', `${id} ${tag}`, fails.slice(0, 3).join(' | '))
        else line('PASS', `${id} ${tag}`)
      }
    }
  } finally {
    await b.close()
  }
}

async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyS2 refuses any endpoint other than the dev AppSync URL')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) {
    throw new Error(`devVerifyS2 only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  }

  // 1. Route-inventory completeness fails first.
  const required = await requiredPatterns()
  const missing = missingFromRoutes(required)
  if (missing.length) {
    line('FAIL', 'route inventory', `no ROUTES entry for: ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }
  line('PASS', 'route inventory', `${required.length} patterns covered`)
  if (flag('inventory')) return

  const email = `zz-s2-admin-${Date.now()}@example.invalid`
  let identity
  const revokes = []
  let ship
  let track
  try {
    identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
    ship = routerAs(identity.token, 'tmsShipmentActions')
    track = routerAs(identity.token, 'tmsTrackingActions')
    console.log(`identity: temporary admin ${email} created`)
    await mkdir(SHOTS, { recursive: true })

    const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-s2-', purpose: 'S2 verification' })
    let tokens = {}
    try {
      await b.navigate('/tms/dashboard')
      await waitLoaded(b).catch(() => {})
      const { data, state } = await discoverData(b, ship)
      console.log(`discovered: ${Object.entries(data).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' ')}`)

      // public tokens (revoked in finally)
      try {
        const bundle = data.transit ? await ship('GET_SHIPMENT_BUNDLE', { shipmentId: data.transit }) : null
        if (bundle) {
          const link = await track('SEND_CUSTOMER_LINK', {
            shipmentId: data.transit, expectedVersion: bundle.shipment.version ?? 0, via: 'COPY', to: [], cc: [],
            expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString(), notes: 'S2 visual verification',
          })
          tokens.customer = link.link.id
          revokes.push(() => track('REVOKE_CUSTOMER_LINK', { trackingLinkId: link.link.id }))
        }
        for (const rec of (state.records ?? []).filter((r) => r.kind === 'SHIPMENT').slice(0, 14)) {
          const bn = await ship('GET_SHIPMENT_BUNDLE', { shipmentId: rec.recordId }).catch(() => null)
          const lc = bn?.loadCarriers?.find((c) => c.id)
          if (!lc) continue
          const ping = await track('SEND_TRACKING_LINK', { loadCarrierId: lc.id, via: 'COPY' }).catch(() => null)
          if (ping) {
            tokens.ping = ping.trackingLinkId ?? ping.link?.id
            revokes.push(() => track('REVOKE_TRACKING_LINK', { trackingLinkId: tokens.ping }))
          }
          const up = await track('SEND_UPLOAD_LINK', { loadCarrierId: lc.id, via: 'COPY' }).catch(() => null)
          if (up?.link?.id) {
            tokens.upload = up.link.id
            revokes.push(() => track('REVOKE_UPLOAD_LINK', { trackingLinkId: up.link.id }))
          }
          if (bn.loadCarriers.some((c) => c.rateConToken)) tokens.rateCon = bn.loadCarriers.find((c) => c.rateConToken).rateConToken
          if (tokens.ping && tokens.upload) break
        }
      } catch (err) {
        console.log(`public link minting incomplete: ${String(err?.message ?? err).slice(0, 160)}`)
      }

      await b.setViewport(1600, 1000, 1)
      // 2–3. light pass: routes then states
      await setTheme(b, 'light').catch(() => {})
      for (const route of ROUTES) await runRoute(b, route, data, 'light')
      for (const st of STATES) await runState(b, st, data, 'light')
      await inboxPanelPersistence(b, data)
      // 4. toast (light then dark)
      await toastProbe(b, 'light')
      // 5. dark pass + pre-paint theme check
      if (!flag('no-dark')) {
        await themePass(b)
        for (const route of ROUTES.filter((r) => r.dark)) await runRoute(b, route, data, 'dark')
        for (const st of STATES.filter((s) => s.dark)) await runState(b, st, data, 'dark')
        await toastProbe(b, 'dark')
        await setTheme(b, 'light').catch(() => {})
      }
    } finally {
      await b.close()
    }

    // 6. public pages in a clean profile (no storage)
    await publicPages(origin, tokens)
  } finally {
    for (const revoke of revokes) await revoke().catch(() => {})
    if (identity || email) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary admin identity ${email} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone && identity) process.exitCode = 1
    }
  }

  // 7. report
  const pass = report.filter((r) => r.status === 'PASS').length
  const fail = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIPPED')
  const unallowed = skipped.filter((r) => !/\(allowed:/.test(r.detail ?? ''))
  console.log(`\nsummary: ${JSON.stringify({ pass, fail, skipped: skipped.length, skippedNotAllowed: unallowed.length })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (fail > 0 || unallowed.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyS2 failed: ${err?.message ?? err}`); process.exit(1) })
}
