#!/usr/bin/env node
/**
 * Step AV live check against DEV (lifecycle tabs): six tabs with the right one lit on every route, badges, a loadReview-only
 * persona, Alt+1..6, no horizontal page scroll at 1280/1440, and the 1440x900 screenshots in Docs/tms-build/screenshots/av/.
 * Throwaway identities only (deleted at the end). Dev only.
 *   node scripts/devVerifyAV.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchBrowser, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'

if (!/f5iqzdpidzalvjys7yxijn5ave/.test(DEV_API) || DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('dev only')
const SHOTS = resolve('Docs/tms-build/screenshots/av')
await mkdir(SHOTS, { recursive: true })
const ts = Date.now()
const emails = { admin: `zz-av-admin-${ts}@example.invalid`, lr: `zz-av-lr-${ts}@example.invalid` }
const KEYS = ['quote', 'build', 'view', 'book', 'track', 'review']
let pass = 0
let fail = 0
const line = (ok, id, msg) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}   ${id} — ${msg}`) }
const index = []

async function strip(b) {
  await b.poll(() => b.evaluate(`!!document.querySelector('[data-testid^="lifecycle-tab-"]')`), 'strip', 30_000)
  await pause(1200)
  return b.evaluate(`({
    tabs: [...document.querySelectorAll('[data-testid^="lifecycle-tab-"]')].map((a) => ({ key: a.getAttribute('data-testid').slice(14), active: a.classList.contains('tms-active'), rect: (({ left, right, width }) => ({ left, right, width }))(a.getBoundingClientRect()) })),
    vw: document.documentElement.clientWidth,
    badges: [...document.querySelectorAll('[data-testid^="lifecycle-badge-"]')].map((e) => e.getAttribute('data-testid').slice(16) + '=' + e.textContent.trim()),
    path: location.pathname,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  })`)
}

const made = []
try {
  const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
  const lr = await mintIdentity(emails.lr, ['page-loadReview']); made.push(emails.lr)
  const open = (id, storage, w = 1440, h = 900) => launchBrowser({ origin: DEV_ORIGIN, storage, profilePrefix: 'bcat-av-', purpose: 'AV verification', viewport: { width: w, height: h, deviceScaleFactor: 1 } })

  const b = await open('admin', admin.storage)
  try {
    await b.navigate('/tms/shipments'); await pause(4000)
    await b.evaluate(`document.querySelector('.tms-main tbody tr')?.click()`); await pause(2500)
    let sid = await b.evaluate(`location.pathname.split('/')[3] ?? ''`)
    if (!sid.startsWith('shp-')) sid = await b.evaluate(`new URLSearchParams(location.search).get('shipment') ?? ''`)
    if (!sid.startsWith('shp-')) sid = 'shp-90460179-4789-44a3-98d0-691662ae6b48' // ZZ DEMO shipment 99671 from the walkthrough
    line(true, 'AV00 fixture', `shipment id for the detail/edit routes: ${sid ? 'board row / ZZ DEMO 99671' : 'none'}`)
    const routes = [
      ['/tms/rates/spot', 'quote', 'quote-inbox'], ['/tms/rates', 'quote', 'quote'], ['/tms/shipments/intake', 'build', 'build-intake'], ['/tms/shipments/new', 'build', 'build-new'],
      [`/tms/shipments/${sid}/edit`, 'build', 'build-edit'], ['/tms/shipments', 'view', 'view-board'], [`/tms/shipments/${sid}`, 'view', 'view-detail'],
      ['/tms/carrier-sales', 'book', 'book'], ['/tms/tracking', 'track', 'track'], ['/tms/load-review', 'review', 'review'],
    ]
    for (const width of [1440, 1280]) {
      await b.setViewport(width, width === 1280 ? 800 : 900)
      for (const [path, want, slug] of routes) {
        await b.navigate(path); await pause(2500)
        const s = await strip(b)
        const lit = s.tabs.filter((t) => t.active).map((t) => t.key)
        // feedback 1: every tab is fully inside the viewport (Review is not clipped) at 1280 and 1440
        const clipped = s.tabs.filter((t) => t.rect.width < 20 || t.rect.left < 0 || t.rect.right > s.vw - 1).map((t) => t.key)
        const ok = s.tabs.map((t) => t.key).join() === KEYS.join() && lit.join() === want && !s.hscroll && clipped.length === 0
        line(ok, `AV01 ${path.startsWith('/tms/shipments/shp') ? path.replace(sid, '<id>') : path} @${width}`, `tabs [${s.tabs.map((t) => t.key)}] lit [${lit}] expected ${want}; page hscroll ${s.hscroll}; tabs clipped/outside viewport [${clipped}] (right edges ${s.tabs.map((t) => Math.round(t.rect.right))} of ${s.vw}); badges ${s.badges.join(' ') || 'none'}`)
        await b.screenshot(join(SHOTS, `strip-${slug}-${width}.png`))
        index.push(`strip-${slug}-${width}.png — ${(sid ? path.replace(sid, '<id>') : path)}: lifecycle strip, ${want} tab lit (${width}x${width === 1280 ? 800 : 900}, admin)`)
      }
    }
    await b.setViewport(1440, 900)
    // badges: any page
    await b.navigate('/tms/shipments'); const s0 = await strip(b)
    line(s0.badges.length >= 1, 'AV02 badges', `badges rendered: ${s0.badges.join(' ') || 'none (all counts zero)'}`)
    // Alt+1..6
    await b.navigate('/tms/dashboard'); await pause(2500)
    const expected = ['/tms/rates/spot', '/tms/shipments/intake', '/tms/shipments', '/tms/carrier-sales', '/tms/tracking', '/tms/load-review']
    const seen = []
    for (let i = 1; i <= 6; i++) {
      await b.command('Input.dispatchKeyEvent', { type: 'keyDown', key: String(i), code: `Digit${i}`, windowsVirtualKeyCode: 48 + i, modifiers: 1 })
      await b.command('Input.dispatchKeyEvent', { type: 'keyUp', key: String(i), code: `Digit${i}`, windowsVirtualKeyCode: 48 + i, modifiers: 1 })
      await pause(1800)
      seen.push(await b.evaluate('location.pathname'))
    }
    line(seen.join() === expected.join(), 'AV03 Alt+1..6', `landed on ${seen.join(' ')}`)
    // feedback 1/2: the Quote page is one page, Quote inbox tab first (default from the strip), Quotes second, URL-backed
    await b.navigate('/tms/dashboard'); await pause(2500)
    await b.evaluate(`document.querySelector('[data-testid="lifecycle-tab-quote"]')?.click()`); await pause(3000)
    const qTabs = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].slice(0, 2).map((t) => ({ text: t.textContent.trim().replace(/[0-9]+$/, ''), sel: t.getAttribute('aria-selected') }))`)
    const qPath = await b.evaluate('location.pathname')
    line(qPath === '/tms/rates/spot' && qTabs[0]?.text === 'Quote inbox' && qTabs[0]?.sel === 'true' && qTabs[1]?.text === 'Quotes', 'AV08 Quote page tabs', `strip Quote lands on ${qPath}; tabs ${JSON.stringify(qTabs)}`)
    await b.screenshot(join(SHOTS, 'quote-tabs-1440.png'))
    index.push('quote-tabs-1440.png — /tms/rates/spot: Quote page tabs, Quote inbox first (selected) then Quotes (1440x900, admin)')
    const inboxBadge = await b.evaluate(`document.querySelector('.tms-main [role="tab"]')?.textContent.trim() ?? ''`)
    console.log(`       quote inbox tab text (badge count if any): ${JSON.stringify(inboxBadge)}`)
    await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].find((t) => /^Quotes/.test(t.textContent.trim()))?.click()`); await pause(2500)
    const qPath2 = await b.evaluate('location.pathname')
    const qSel2 = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].slice(0, 2).filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent.trim().replace(/[0-9]+$/, ''))`)
    line(qPath2 === '/tms/rates' && qSel2.join() === 'Quotes', 'AV09 Quotes tab URL', `click Quotes -> ${qPath2}, selected ${JSON.stringify(qSel2)}`)
    // feedback 1: Carriers page, Find & Invite first (default) then Carrier list, URL-backed; one sidebar entry
    const carrierPages = [['/tms/carriers/find', 'Find & Invite'], ['/tms/carriers', 'Carrier list']]
    const carriersFixture = await b.evaluate(`1`)
    for (const [path, want] of carrierPages) {
      await b.navigate(path); await pause(3500)
      const c = await b.evaluate(`({ path: location.pathname, tabs: [...document.querySelectorAll('.tms-main [role="tab"]')].slice(0, 2).map((t) => t.textContent.trim()), sel: [...document.querySelectorAll('.tms-main [role="tab"]')].slice(0, 2).filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent.trim()), lit: [...document.querySelectorAll('.tms-nav-row.tms-active')].map((e) => e.textContent.trim()), carriersRows: [...document.querySelectorAll('.tms-nav-row')].filter((e) => /^Carriers$/.test(e.textContent.trim())).length, findChild: [...document.querySelectorAll('.tms-nav-row')].some((e) => /Find & Invite/.test(e.textContent)) })`)
      line(c.tabs.join() === 'Find & Invite,Carrier list' && c.sel.join() === want && c.lit.join() === 'Carriers' && c.carriersRows === 1 && !c.findChild, `AV10 Carriers ${path}`, `tabs ${JSON.stringify(c.tabs)} selected ${JSON.stringify(c.sel)}; sidebar lit ${JSON.stringify(c.lit)}; Carriers rows ${c.carriersRows}; Find&Invite child ${c.findChild}`)
      if (path === '/tms/carriers/find') { await b.screenshot(join(SHOTS, 'carriers-tabs-1440.png')); index.push('carriers-tabs-1440.png — /tms/carriers/find: Carriers page tabs, Find & Invite first (selected) then Carrier list; sidebar one Carriers entry lit (1440x900, admin)') }
    }
    // /tms/carriers/<id>: open the first carrier row of the list
    await b.evaluate(`document.querySelector('.tms-main tbody tr')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await pause(3500)
    let cid = await b.evaluate('location.pathname')
    const cd = await b.evaluate(`({ lit: [...document.querySelectorAll('.tms-nav-row.tms-active')].map((e) => e.textContent.trim()), tabs: [...document.querySelectorAll('.tms-main [role="tab"]')].slice(0, 2).map((t) => t.textContent.trim()) })`)
    line(/^\/tms\/carriers\/[^/]+$/.test(cid) && cd.lit.join() === 'Carriers', 'AV11 Carriers /tms/carriers/<id>', `at ${cid.replace(/carriers\/.+/, 'carriers/<id>')}; sidebar lit ${JSON.stringify(cd.lit)}; tabs ${JSON.stringify(cd.tabs)}`)
    // feedback 1: Customers has no Follow-ups; the old URL redirects
    await b.navigate('/tms/customers/follow-ups'); await pause(3500)
    const cu = await b.evaluate(`({ path: location.pathname, followRows: [...document.querySelectorAll('.tms-nav-row')].filter((e) => /Follow-?ups?/i.test(e.textContent)).length, lit: [...document.querySelectorAll('.tms-nav-row.tms-active')].map((e) => e.textContent.trim()) })`)
    line(cu.path === '/tms/customers' && cu.followRows === 0, 'AV12 Customers no Follow-ups', `/tms/customers/follow-ups -> ${cu.path}; Follow-ups sidebar rows ${cu.followRows}; lit ${JSON.stringify(cu.lit)}`)
    // feedback 3: Intake opens on All loads; By rev division / By customer split the same rows; URL-backed (read-only)
    await b.navigate('/tms/shipments/intake'); await pause(4500)
    const intakeState = () => b.evaluate(`(() => {
      const sel = (id) => document.querySelector('[data-testid="' + id + '"]')?.getAttribute('aria-selected')
      const counts = [...document.querySelectorAll('[data-testid^="intake-group-count-"]')].map((e) => [e.getAttribute('data-testid').slice(19), Number(e.textContent.trim())])
      return { all: sel('intake-view-all'), division: sel('intake-view-division'), customer: sel('intake-view-customer'), counts, search: location.search }
    })()`)
    const iv0 = await intakeState()
    await b.evaluate(`document.querySelector('[data-testid="intake-view-division"]')?.click()`); await pause(1200)
    const ivD = await intakeState()
    await b.evaluate(`document.querySelector('[data-testid="intake-view-customer"]')?.click()`); await pause(1200)
    const ivC = await intakeState()
    const sumOf = (st) => st.counts.filter(([id]) => id !== 'all').reduce((n, [, c]) => n + c, 0)
    const allOf = (st) => st.counts.find(([id]) => id === 'all')?.[1]
    await b.navigate('/tms/shipments/intake?view=customer'); await pause(4500)
    const ivR = await intakeState()
    line(
      iv0.all === 'true' && iv0.search === '' && ivD.division === 'true' && /view=division/.test(ivD.search) && sumOf(ivD) === allOf(ivD) && ivC.customer === 'true' && /view=customer/.test(ivC.search) && sumOf(ivC) === allOf(ivC) && ivR.customer === 'true' && ivR.search === '?view=customer',
      'AV13 Intake All loads / by division / by customer',
      `default All selected ${iv0.all}, url "${iv0.search}"; division sub-tab counts sum ${sumOf(ivD)} vs All ${allOf(ivD)}, url ${ivD.search}; customer sum ${sumOf(ivC)} vs All ${allOf(ivC)}, url ${ivC.search}; reload ${ivR.search} keeps customer ${ivR.customer}`,
    )
    // sidebar
    await b.navigate('/tms/dashboard'); await pause(3000)
    const rail = await b.evaluate(`[...document.querySelectorAll('.tms-nav-rowwrap, .tms-section-head')].map((e) => e.textContent.trim().split('\\n')[0].slice(0, 40))`)
    console.log('       brokerage rail:', JSON.stringify(rail.slice(0, 12)))
    const brokerage = rail.slice(0, rail.findIndex((x) => /^ASSETS/.test(x)) < 0 ? rail.length : rail.findIndex((x) => /^ASSETS/.test(x)))   // the Ivan Cartage assets section below is a different division's rail
    const all = brokerage.join(' | ')
    const hasAll = ['Company Dashboard', 'Active shipments', 'Accounting', 'Settings'].every((x) => all.includes(x))
    const gone = ['Quotes', 'Intake', 'Carrier Sales', 'Load Tracking', 'Load Review', 'New shipment'].filter((x) => all.includes(x))
    line(hasAll && gone.length === 0, 'AV04 sidebar', `has the kept rows: ${hasAll}; lifecycle rows still in rail: ${gone.join(', ') || 'none'}`)
    await b.screenshot(join(SHOTS, 'sidebar-1440.png'))
    await b.setViewport(1280, 800); await pause(1500)
    await b.screenshot(join(SHOTS, 'sidebar-1280.png'))
    index.push('sidebar-1280.png — sidebar at 1280x800 (admin, dashboard)')
    await b.setViewport(1440, 900); await pause(1000)
    index.push('sidebar-1440.png — sidebar: Company Dashboard, Active shipments, directories, Accounting, Settings (1440x900, admin, dashboard)')
  } finally { await b.close() }

  const l = await open('lr', lr.storage)
  try {
    await l.navigate('/tms/dashboard'); await pause(4000)
    const s = await strip(l)
    line(s.tabs.map((t) => t.key).join() === 'review', 'AV05 loadReview persona strip', `tabs [${s.tabs.map((t) => t.key)}] at ${s.path}`)
    await l.navigate('/tms/load-review'); await pause(3000)
    const s2 = await strip(l)
    line(s2.path === '/tms/load-review' && s2.tabs.length === 1 && s2.tabs[0].active, 'AV06 /tms/load-review opens', `at ${s2.path}, review lit ${s2.tabs[0]?.active}`)
    await l.screenshot(join(SHOTS, 'persona-load-review-1440.png'))
    index.push('persona-load-review-1440.png — user holding only page-loadReview: one tab (Review), /tms/load-review open (1440x900)')
    for (const p of ['/tms/rates', '/tms/shipments', '/tms/carrier-sales', '/tms/tracking', '/tms/shipments/new']) {
      await l.navigate(p); await pause(2500)
      const at = await l.evaluate('location.pathname')
      line(at === '/tms/load-review', `AV07 refused ${p}`, `landed on ${at}`)
    }
  } finally { await l.close() }
} finally {
  for (const e of made) console.log(`cleanup: ${e} ${(await deleteIdentity(e)) ? 'deleted and confirmed gone' : 'NOT CONFIRMED GONE'}`)
}
await writeFile(join(SHOTS, 'index.txt'), `${index.join('\n')}\n`)
console.log(`summary: ${JSON.stringify({ pass, fail })}`)
process.exitCode = fail ? 1 : 0
