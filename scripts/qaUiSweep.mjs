#!/usr/bin/env node
/**
 * QA UI sweep on the DEPLOYED dev app (fresh-eyes pass over the UI-feedback screenshots and rules).
 *
 *   node scripts/qaUiSweep.mjs --only=boards,drawer,nav,routes,dashboard,theme   (default: all)
 *
 * Dev only (cdpBrowser refuses every other origin). Mints throwaway identities on the dev Cognito pool
 * (zz-qaui-*), deletes them and proves them gone in `finally`. Read-only on data: it only changes the
 * temp users' own localStorage prefs. Logs counts / booleans / computed styles; never cell text, e-mail or token.
 * Screenshots: Docs/tms-build/screenshots/qa/
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser, pause } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'
import { AA_OLD_URLS, AA_SIDEBAR } from './lib/aaRoutes.mjs'

const SHOTS = resolve('Docs/tms-build/screenshots/qa')
const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const want = (k) => only.length === 0 || only.includes(k)
const results = []
const rec = (area, name, status, detail) => {
  results.push({ area, name, status, detail })
  console.log(`${status.padEnd(7)} [${area}] ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const ts = Date.now()
const mk = []
async function ident(label, groups) {
  const email = `zz-qaui-${label}-${ts}@bcatcorp.com`
  const id = await mintIdentity(email, groups)
  mk.push(email)
  return { email, ...id }
}
const open = (storage, viewport = { width: 1440, height: 900 }) => launchBrowser({ storage, viewport, profilePrefix: 'bcat-qaui-', purpose: 'QA UI sweep' })
const shot = (b, name) => b.screenshot(`${SHOTS}/${name}.png`)
const waitShell = (b) => b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell', 60_000)
async function openBoard(b, path, width = 1440, height = 900) {
  await b.setViewport(width, height)
  await b.navigate(path)
  await b.waitFor('.tms-dg-scroll', 60_000)
  await b.poll(async () => (await b.evaluate(`!!document.querySelector('.tms-dg-table tbody tr:not(.tms-dg-spacer)')`)), 'rows', 40_000).catch(() => {})
  await pause(2500)
}

// ───────────────────────────── boards: rules AC2 does not cover ─────────────────────────────
const BOARDS = [
  ['shipments-active', '/tms/shipments'],
  ['shipments-all', '/tms/shipments?list=all'],
  ['intake', '/tms/shipments/intake'],
  ['tracking', '/tms/tracking?assignee=all'],
  ['customers', '/tms/customers'],
  ['carriers', '/tms/carriers'],
]
async function boards(admin) {
  const b = await open(admin.storage)
  try {
    for (const [id, path] of BOARDS) {
      await openBoard(b, path)
      // 1. header-measured widths >= 72, headers not truncated, no horizontal scroll, page itself does not overflow
      const heads = await b.evaluate(`(() => {
        const scroll = document.querySelector('.tms-dg-scroll')
        const ths = [...scroll.querySelectorAll('thead th')].filter((h) => !h.classList.contains('tms-dg-check') && h.textContent.trim() !== '')
        const widths = ths.map((h) => Math.round(h.getBoundingClientRect().width))
        const truncated = ths.filter((h) => { const l = h.querySelector('.tms-dg-th-label'); return l && l.scrollWidth > l.clientWidth + 1 }).map((h) => h.querySelector('.tms-dg-th-label').textContent.trim())
        return { n: ths.length, min: Math.min(...widths), widths, truncated, hScroll: scroll.scrollWidth > scroll.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
      })()`)
      rec('boards', `${id} header-measured widths`, heads.min >= 72 && heads.truncated.length === 0 ? 'PASS' : 'FAIL', `${heads.n} columns, min ${heads.min}px, truncated headers ${heads.truncated.length}, hScroll ${heads.hScroll}, page overflow ${heads.pageOverflow}`)
      rec('boards', `${id} default columns fit 1440`, !heads.hScroll ? 'PASS' : 'FAIL', `${heads.n} columns, no horizontal scroll: ${!heads.hScroll}`)
      // 2. 100 rows virtualised: rows in the DOM vs rows the table's height implies
      const virt = await b.evaluate(`(() => {
        const t = document.querySelector('.tms-dg-table'); const head = t.querySelector('thead').offsetHeight
        const rows = [...t.querySelectorAll('tbody tr:not(.tms-dg-spacer):not(.tms-dg-group)')]
        const rh = rows[0]?.getBoundingClientRect().height ?? 0
        const total = rh ? Math.round((t.offsetHeight - head - t.querySelectorAll('tbody tr.tms-dg-group').length * rh) / rh) : 0
        const foot = [...document.querySelectorAll('.tms-main *')].map((e) => e.children.length === 0 ? e.textContent.trim() : '').find((x) => /^(showing|\\d+ (shipments|loads|rows|customers|carriers|intake))/i.test(x)) ?? ''
        return { mounted: rows.length, total, rh, foot: foot.replace(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g, ''), spacers: t.querySelectorAll('tbody tr.tms-dg-spacer').length }
      })()`)
      rec('boards', `${id} rows virtualised`, virt.total > 0 && virt.mounted <= Math.max(60, virt.total) ? (virt.total > 60 ? (virt.mounted < virt.total ? 'PASS' : 'FAIL') : 'INFO') : 'FAIL', `${virt.mounted} rows mounted of ${virt.total} laid out (row ${virt.rh}px, spacers ${virt.spacers}); footer "${virt.foot.slice(0, 60)}"`)
      // 3. summary strip collapsible
      const sum = await b.evaluate(`(() => { const btn = [...document.querySelectorAll('button')].find((x) => /^\\s*Summary\\s*$/.test(x.textContent)); if (!btn) return null; const open0 = !!document.querySelector('#tms-dg-kpi'); btn.click(); return { has: true, open0 } })()`)
      if (!sum) rec('boards', `${id} KPI strip collapsible`, 'FAIL', 'no Summary button')
      else {
        await pause(400)
        const open1 = await b.evaluate(`!!document.querySelector('#tms-dg-kpi')`)
        const kpis = open1 ? await b.evaluate(`document.querySelectorAll('#tms-dg-kpi .tms-dg-kpi-value').length`) : 0
        await b.evaluate(`[...document.querySelectorAll('button')].find((x) => /^\\s*Summary\\s*$/.test(x.textContent))?.click()`)
        await pause(300)
        const open2 = await b.evaluate(`!!document.querySelector('#tms-dg-kpi')`)
        rec('boards', `${id} KPI strip collapsible`, open1 !== sum.open0 && open2 === sum.open0 ? 'PASS' : 'FAIL', `open ${sum.open0} -> ${open1} (${kpis} KPIs) -> ${open2}`)
      }
      // 4. Columns dialog structure
      const opened = await b.click({ text: 'Columns' }).then(() => true, () => false)
      if (!opened) { rec('boards', `${id} Columns dialog`, 'FAIL', 'no Columns button'); continue }
      await b.waitFor('.tms-cd-panes', 10_000).catch(() => {})
      await pause(500)
      const cd = await b.evaluate(`(() => {
        const q = (s) => [...document.querySelectorAll(s)]
        const fields = q('.tms-cd-field'); const rows = q('[data-testid="cd-chosen"] .tms-cd-row')
        const h = (el) => Math.round(el.getBoundingClientRect().height)
        const grp = document.querySelector('.tms-cd-group'); const gs = grp && getComputedStyle(grp)
        const dlg = document.querySelector('.tms-columns-dialog'); const r = dlg.getBoundingClientRect()
        const list = document.querySelector('[data-testid="cd-available"]')
        const row0 = rows[0]
        return {
          panes: q('.tms-cd-pane').length, search: !!document.querySelector('input[aria-label="Search columns"]'),
          fieldHeights: [...new Set(fields.slice(0, 40).map(h))], rowHeights: [...new Set(rows.map(h))],
          groups: q('.tms-cd-group').length, groupSticky: gs?.position, groupTop: gs?.top,
          selectAllBtns: q('button[aria-label^="Select all in"]').length,
          grip: !!row0?.querySelector('.tms-cd-grip'), draggable: row0?.getAttribute('draggable'), width: !!row0?.querySelector('input.tms-cd-width'),
          pin: !!row0?.querySelector('button[aria-label^="Pin"], button[aria-label^="Unpin"]'), remove: !!row0?.querySelector('button[aria-label^="Remove"]'),
          resetWidths: q('button').some((x) => x.textContent.trim() === 'Reset widths'),
          templates: !!document.querySelector('.tms-cd-templates'), templateName: !!document.querySelector('input[aria-label="Template name"]'),
          dlg: { w: Math.round(r.width), h: Math.round(r.height), insideViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight },
          listScrolls: list.scrollHeight > list.clientHeight, chosenCount: rows.length,
        }
      })()`)
      const okRows = cd.fieldHeights.every((x) => x === 36) && cd.rowHeights.every((x) => x === 36)
      rec('boards', `${id} Columns dialog rows 36px`, okRows ? 'PASS' : 'FAIL', `field rows ${JSON.stringify(cd.fieldHeights)}, chosen rows ${JSON.stringify(cd.rowHeights)}`)
      rec('boards', `${id} Columns dialog structure`, cd.panes === 2 && cd.search && cd.groupSticky === 'sticky' && cd.selectAllBtns >= 1 && cd.grip && cd.width && cd.pin && cd.remove && cd.resetWidths && cd.dlg.insideViewport ? 'PASS' : 'FAIL',
        `panes ${cd.panes}, search ${cd.search}, ${cd.groups} sticky group headers (${cd.groupSticky}), select-all-in-group ${cd.selectAllBtns}, grip ${cd.grip}/draggable ${cd.draggable}, width ${cd.width}, pin ${cd.pin}, remove ${cd.remove}, Reset widths ${cd.resetWidths}, dialog ${cd.dlg.w}x${cd.dlg.h} inside window ${cd.dlg.insideViewport}`)
      rec('boards', `${id} Columns dialog templates row`, cd.templates && cd.templateName ? 'PASS' : 'INFO', `templates row ${cd.templates} (name input ${cd.templateName})`)
      // search narrows + sticky header holds while the list scrolls
      const search = await b.evaluate(`(() => {
        const input = document.querySelector('input[aria-label="Search columns"]'); const before = document.querySelectorAll('.tms-cd-field').length
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'st'); input.dispatchEvent(new Event('input', { bubbles: true }))
        return before })()`)
      await pause(300)
      const afterSearch = await b.evaluate(`document.querySelectorAll('.tms-cd-field').length`)
      await b.evaluate(`(() => { const input = document.querySelector('input[aria-label="Search columns"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await pause(300)
      const stick = await b.evaluate(`(() => {
        const list = document.querySelector('[data-testid="cd-available"]'); const heads = [...list.querySelectorAll('.tms-cd-group')]
        if (!list || heads.length < 2 || list.scrollHeight <= list.clientHeight) return { skip: true, groups: heads.length }
        const lr = list.getBoundingClientRect(); list.scrollTop = Math.max(0, heads[1].offsetTop - 60)
        const tops = heads.map((h) => Math.round(h.getBoundingClientRect().top - lr.top))
        const stuck = tops.filter((t) => t >= -1 && t <= 2).length
        list.scrollTop = 0; return { skip: false, stuck, groups: heads.length }
      })()`)
      rec('boards', `${id} Columns dialog search + sticky group header`, afterSearch < search && (stick.skip || stick.stuck >= 1) ? 'PASS' : (afterSearch < search ? 'PARTIAL' : 'FAIL'), `search "st": ${search} -> ${afterSearch} fields; sticky group header while scrolled: ${JSON.stringify(stick)}`)
      if (id === 'shipments-active') await shot(b, 'columns-dialog-1440')
      await b.click({ text: 'Cancel' }).catch(() => {})
      await pause(300)
    }
    // density toggle on a dense board: row heights differ
    await openBoard(b, '/tms/shipments')
    const rh = async () => b.evaluate(`document.querySelector('.tms-dg-table tbody tr:not(.tms-dg-spacer):not(.tms-dg-group)').getBoundingClientRect().height`)
    const compact = await rh(); await b.click({ text: 'Comfortable' }); await pause(400); const comfy = await rh(); await b.click({ text: 'Compact' })
    rec('boards', 'density toggle changes row height', comfy > compact ? 'PASS' : 'FAIL', `compact ${compact}px, comfortable ${comfy}px`)
  } finally { await b.close() }
}

// ───────────────────────────── tracking drawer ─────────────────────────────
async function drawer(admin) {
  const b = await open(admin.storage)
  try {
    await openBoard(b, '/tms/tracking?assignee=all')
    const clicked = await b.evaluate(`(() => { const tr = document.querySelector('.tms-dg-scroll tbody tr:not(.tms-dg-spacer):not(.tms-dg-group)'); if (!tr) return false; tr.click(); return true })()`)
    if (!clicked) return rec('drawer', 'open drawer', 'FAIL', 'no tracking row to open')
    await b.waitFor('[data-testid="tracking-drawer"]', 30_000)
    await b.poll(() => b.evaluate(`!!document.querySelector('[data-testid="tracking-prefs-row"]')`), 'prefs row', 40_000).catch(() => {})
    await pause(5000)
    const f = await b.evaluate(`(() => {
      const root = document.querySelector('.tms-tracking-drawer'); const body = document.querySelector('[data-testid="tracking-drawer"]')
      const rect = (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left) } }
      const prefs = document.querySelector('[data-testid="tracking-prefs-row"]')
      const prefsPopover = [...root.querySelectorAll('button')].some((x) => /^Tracking: /.test(x.textContent.trim())) || !!prefs?.querySelector('button[aria-haspopup]')
      const selects = prefs ? [...prefs.querySelectorAll('select')].map((s) => s.getAttribute('aria-label')) : []
      const prefsVisible = prefs ? rect(prefs) : null
      const header = root.querySelector('header, .tms-drawer-header') ?? root.firstElementChild
      const strip = root.querySelector('.tms-tracking-strip, [data-testid="tracking-strip"]')
      const mapHead = [...root.querySelectorAll('button')].find((x) => /map/i.test(x.getAttribute('aria-label') ?? '') && /(expand|collapse|show|hide)/i.test(x.getAttribute('aria-label') ?? ''))
      const maps = root.querySelectorAll('.gm-style, [data-testid*="map"], [class*="tracking-map"]').length
      const convos = [...root.querySelectorAll('.tms-convo-stream')].map((s) => ({ rect: rect(s), scrollH: s.scrollHeight, clientH: s.clientHeight, overflowY: getComputedStyle(s).overflowY }))
      const panes = [...root.querySelectorAll('.tms-tracking-pane')].map(rect)
      const recent = [...root.querySelectorAll('.tms-recent-row')].length
      const comp = root.querySelector('.tms-recent'); const last = comp ? rect(comp) : null
      return { vh: innerHeight, drawer: rect(root), bodyScrollH: body.scrollHeight, bodyClientH: body.clientHeight, bodyOverflow: getComputedStyle(body).overflowY, prefsPopover, selects, prefsVisible, stripTop: strip ? rect(strip) : null,
        mapToggle: mapHead?.getAttribute('aria-label') ?? null, mapBtns: [...root.querySelectorAll('button')].map((x) => x.getAttribute('aria-label') ?? x.textContent.trim()).filter((t) => /map|collapse|expand/i.test(t)).slice(0, 6),
        maps, convos, panes, recent, recentBox: last, hasLogBtn: [...root.querySelectorAll('button')].some((x) => /log check call/i.test(x.textContent)) }
    })()`)
    rec('drawer', 'prefs row inline, no popover', f.selects.length === 3 && !f.prefsPopover ? 'PASS' : 'FAIL', `selects ${JSON.stringify(f.selects)}, popover trigger ${f.prefsPopover}, row box ${JSON.stringify(f.prefsVisible)}`)
    rec('drawer', 'two conversation panes', f.convos.length === 2 ? 'PASS' : 'FAIL', `${f.convos.length} streams, panes ${JSON.stringify(f.panes)}`)
    rec('drawer', 'conversation panes scroll independently', f.convos.length === 2 && f.convos.every((c) => c.overflowY === 'auto' || c.overflowY === 'scroll') ? 'PASS' : 'FAIL', JSON.stringify(f.convos))
    rec('drawer', 'last 5 check calls', f.recent === 5 ? 'PASS' : (f.recent > 0 && f.recent < 5 ? 'PARTIAL' : 'FAIL'), `${f.recent} rows in Recent check calls (shipment has at least 5: ${f.recent >= 5})`)
    const lastBottom = Math.max(f.recentBox?.bottom ?? 0)
    rec('drawer', 'everything above the fold at 900px', lastBottom > 0 && lastBottom <= f.vh && f.bodyScrollH <= f.bodyClientH + 1 ? 'PASS' : 'FAIL', `check calls end at ${lastBottom}px of ${f.vh}; body scrollHeight ${f.bodyScrollH} vs client ${f.bodyClientH} (${f.bodyOverflow})`)
    rec('drawer', 'map panel collapsible', 'PENDING', JSON.stringify({ mapToggle: f.mapToggle, mapBtns: f.mapBtns, maps: f.maps }))
    await shot(b, 'tracking-drawer-1440x900')
    // header height: one row
    const hdr = await b.evaluate(`(() => { const root = document.querySelector('.tms-tracking-drawer'); const h = root.querySelector('.tms-drawer-head, header, [class*="drawer-header"]') ; const r = h?.getBoundingClientRect(); const strip = document.querySelector('[data-testid="tracking-strip"]'); const sr = strip?.getBoundingClientRect(); return { headH: r ? Math.round(r.height) : null, strip: sr ? { top: Math.round(sr.top), h: Math.round(sr.height) } : null, stripRows: strip ? [...new Set([...strip.children].map((c) => Math.round(c.getBoundingClientRect().top)))].length : null } })()`)
    rec('drawer', 'one-row header', hdr.headH != null && hdr.headH <= 56 ? 'PASS' : 'PARTIAL', JSON.stringify(hdr))
    // map collapse
    const mapState = () => b.evaluate(`(() => { const root = document.querySelector('.tms-tracking-drawer'); const btn = [...root.querySelectorAll('button')].find((x) => /^(Hide|Show) map$/.test(x.getAttribute('aria-label') ?? '')); return { label: btn?.getAttribute('aria-label') ?? null, mapH: Math.round(root.querySelector('.gm-style')?.getBoundingClientRect().height ?? 0), recentBottom: Math.round(root.querySelector('.tms-recent')?.getBoundingClientRect().bottom ?? 0) } })()`)
    const m0 = await mapState()
    await b.evaluate(`[...document.querySelectorAll('.tms-tracking-drawer button')].find((x) => /^(Hide|Show) map$/.test(x.getAttribute('aria-label') ?? ''))?.click()`)
    await pause(900)
    const m1 = await mapState()
    const i = results.findIndex((r) => r.name === 'map panel collapsible')
    results[i] = { area: 'drawer', name: 'map panel collapsible', status: m0.label === 'Hide map' && m1.label === 'Show map' && m1.mapH < m0.mapH ? 'PASS' : 'FAIL', detail: `${m0.label} (map ${m0.mapH}px) -> ${m1.label} (map ${m1.mapH}px); check calls end ${m0.recentBottom} -> ${m1.recentBottom}px` }
    console.log(`${results[i].status} [drawer] map panel collapsible: ${results[i].detail}`)
    await shot(b, 'tracking-drawer-map-collapsed')
  } finally { await b.close() }
}

// ───────────────────────────── nav per role ─────────────────────────────
const SIDEBAR_JS = `(() => {
  const nav = document.querySelector('nav[aria-label="TMS sections"]') ?? document.querySelector('.tms-sidebar')
  const text = (el) => (el?.textContent ?? '').trim(); const rows = []; let section = null
  for (const el of nav.querySelectorAll('.tms-section-head, .tms-nav-rowwrap')) {
    if (el.classList.contains('tms-section-head')) { section = text(el); continue }
    const row = el.querySelector(':scope > .tms-nav-row')
    if (row) rows.push({ section, depth: 0, label: text(row.querySelector('.tms-nav-label')), href: row.getAttribute('href') })
    for (const c of el.querySelectorAll('.tms-nav-child')) rows.push({ section, depth: 1, label: text(c.querySelector('.tms-nav-child-label')), href: c.getAttribute('href') })
  }
  return rows })()`
async function navFor(roleLabel, identity, wantRows) {
  const b = await open(identity.storage)
  try {
    await b.navigate('/')
    await waitShell(b)
    await b.poll(async () => (await b.evaluate(`location.pathname`)) !== '/', 'landing', 20_000).catch(() => {})
    await pause(2500)
    const landing = await b.evaluate(`location.pathname`)
    // open every group so children would show
    for (let i = 0; i < 12; i += 1) { const n = await b.evaluate(`(() => { const c = document.querySelector('.tms-nav-rowwrap > .tms-nav-caret[aria-expanded="false"]'); if (!c) return 0; c.click(); return 1 })()`); if (!n) break; await pause(150) }
    await b.navigate('/tms/tracking?assignee=all'); await waitShell(b).catch(() => {}); await pause(3500)
    for (let i = 0; i < 12; i += 1) { const n = await b.evaluate(`(() => { const c = document.querySelector('.tms-nav-rowwrap > .tms-nav-caret[aria-expanded="false"]'); if (!c) return 0; c.click(); return 1 })()`); if (!n) break; await pause(150) }
    const rows = await b.evaluate(SIDEBAR_JS)
    const trackingRows = rows.filter((r) => /tracking/i.test(r.label) || /^\/tms\/tracking/.test(r.href ?? ''))
    const trackingLinks = await b.evaluate(`[...document.querySelectorAll('.tms-sidebar a')].filter((a) => /^\\/tms\\/tracking/.test(a.getAttribute('href') ?? '')).map((a) => a.getAttribute('href'))`)
    const trackTab = await b.evaluate(`[...document.querySelectorAll('[data-testid="lifecycle-tab-track"]')].map((a) => ({ href: a.getAttribute('href'), lit: a.classList.contains('tms-active') }))`)
    const feedback = await b.evaluate(`!!document.querySelector('a[href="/feedback"]')`)
    const top = rows.filter((r) => r.depth === 0 && r.section === null).map((r) => r.label)
    const ok = trackingRows.length === 0 && trackingLinks.length === 0 && trackTab.length === 1 && trackTab[0].href === '/tms/tracking' && trackTab[0].lit
    rec('nav', `${roleLabel}: Load Tracking is the Track lifecycle tab (lit on /tms/tracking), not a sidebar row`, ok ? 'PASS' : 'FAIL', `landing ${landing}; tracking sidebar rows ${trackingRows.length} ${JSON.stringify(trackingRows.map((r) => `${r.depth}|${r.label}`))}, tracking links in sidebar ${trackingLinks.length}, Track tab ${JSON.stringify(trackTab)}; pinned top-level: ${JSON.stringify(top)}`)
    rec('nav', `${roleLabel}: Feedback link`, feedback ? 'PASS' : 'FAIL', `a[href="/feedback"] present ${feedback}`)
    await shot(b, `nav-${roleLabel.replace(/[^a-z]/gi, '')}-1440`)
    return { rows, top }
  } finally { await b.close() }
}
async function nav(admin, loadsOnly, viewerTms) {
  const a = await navFor('owner/admin', admin, { tracking: true })
  const want = AA_SIDEBAR.filter((r) => r[2] === 0).map((r) => r[0])
  const got = a.rows.filter((r) => r.depth === 0 && r.section === null).map((r) => r.label)
  rec('nav', 'admin: top-level order = Company Dashboard / Active shipments / Customers / Carriers / Locations / Accounting / Settings (lifecycle pages are the top-bar strip)', JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL', `got ${JSON.stringify(got)}`)
  const kids = Object.fromEntries(['Accounting'].map((p) => [p, a.rows.filter((r, i) => r.depth === 1 && a.rows.slice(0, i).reverse().find((x) => x.depth === 0)?.label === p).map((r) => r.label)]))
  rec('nav', 'admin: Accounting children incl. Vendors; Shipments group is gone', kids.Accounting.includes('Vendors') && !a.rows.some((r) => r.label === 'Shipments') ? 'PASS' : 'FAIL', JSON.stringify(kids))
  await navFor('page-loads only', loadsOnly, { tracking: true })
  await navFor('viewer with tms', viewerTms, { tracking: true })
}

// ───────────────────────────── old-URL redirects (20 spot checks) ─────────────────────────────
const SPOT = [
  '/', '/tms', '/loads', '/grid', '/shipments', '/customers', '/carriers', '/locations', '/quotes', '/rates', '/tms/rates/lanes', '/check-calls',
  '/tms/check-calls', '/documents', '/tms/documents/review', '/tms/tracking/links', '/tms/dispatch', '/ar', '/ap', '/vendor-ap', '/settings', '/users', '/reports', '/feedback', '/tms/shipments/view/all-shipments', '/tms/shipments?list=all',
]
async function routes(admin) {
  const b = await open(admin.storage)
  try {
    const fails = []
    for (const url of SPOT) {
      const exp = AA_OLD_URLS.find((r) => r[0] === url)
      if (!exp) { fails.push(`${url}: not in AA_OLD_URLS`); continue }
      const [, landing, wantSearch] = exp
      b.mark()
      await b.navigate(url)
      let landed = ''
      try { await b.poll(async () => { landed = await b.evaluate(`location.pathname`); return landed === landing }, 'landing', 20_000) } catch { fails.push(`${url} landed on ${landed}, wanted ${landing}`); continue }
      await pause(1500)
      const f = await b.evaluate(`({ search: location.search, shell: !!document.querySelector('.tms-sidebar'), main: (document.querySelector('.tms-main')?.innerText ?? '').trim().length, noAccess: /no page access/i.test(document.body.innerText) })`)
      if (wantSearch && f.search !== wantSearch) fails.push(`${url}: search ${f.search}, wanted ${wantSearch}`)
      if (!f.shell) fails.push(`${url}: no shell`)
      if (!f.main) fails.push(`${url}: empty main`)
      if (f.noAccess) fails.push(`${url}: No page access`)
      const ex = b.problems().exceptions
      if (ex.length) fails.push(`${url}: ${ex.length} page exception(s)`)
    }
    rec('routes', `${SPOT.length} old URLs land correctly (incl. lane rates, check-calls, documents, tracking/links off-nav)`, fails.length ? 'FAIL' : 'PASS', fails.length ? fails.join(' | ') : `${SPOT.length}/${SPOT.length} land on the registry's pathname+search inside the shell with content`)
  } finally { await b.close() }
}

// ───────────────────────────── dashboards ─────────────────────────────
async function kpiTimes(admin) {
  const times = []
  let asof = null
  for (let i = 0; i < 3; i += 1) {
    const b = await open(admin.storage)
    try {
      const t0 = Date.now()
      await b.navigate('/tms/dashboard')
      let ready = false
      while (Date.now() - t0 < 40_000 && !ready) {
        ready = await b.evaluate(`(() => { const k = document.querySelector('[data-testid="dash-kpis"]'); if (!k || k.querySelector('.tms-kpi-skeleton')) return false; const t = k.innerText; return (t.match(/\\$[\\d,]+/g) || []).length >= 4 && /\\d+ shipments?/.test(t) })()`)
        if (!ready) await pause(100)
      }
      times.push(ready ? Date.now() - t0 : null)
      asof = asof ?? (await b.evaluate(`document.querySelector('[data-testid="dash-asof"]')?.innerText ?? null`))
      if (i === 0) await shot(b, 'dashboard-1440')
    } finally { await b.close() }
  }
  return { times, asof }
}
async function dashboard(admin, tmsPlain, claim) {
  const { times, asof } = await kpiTimes(admin)
  const ok = times.filter((t) => t != null)
  const sorted = [...ok].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)]
  rec('dashboard', 'Company Dashboard KPIs < 3 s cold', ok.length === 3 && median < 3000 ? 'PASS' : (ok.length && sorted[0] < 3000 ? 'PARTIAL' : 'FAIL'), `3 cold loads (fresh profile each): ${JSON.stringify(times)} ms; median ${median} ms; best ${sorted[0]} ms`)
  rec('dashboard', "'as of' label", asof ? 'PASS' : 'FAIL', `data-testid=dash-asof present: ${!!asof}${asof ? ` ("${asof.replace(/\d/g, '#')}")` : ''}`)
  for (const [label, who, expect] of [['admin', admin, true], ['page-tms without the claim', tmsPlain, false], ['page-tms with claim-DASHBOARDS_CREATE', claim, true]]) {
    const b = await open(who.storage)
    try {
      await b.navigate('/tms/dashboard'); await waitShell(b)
      await b.poll(() => b.evaluate(`!!document.querySelector('.dash-home-bar')`), 'dash bar', 40_000).catch(() => {})
      await pause(1500)
      const has = await b.evaluate(`!!document.querySelector('[data-testid="dash-new"]') || [...document.querySelectorAll('button')].some((x) => /New dashboard/.test(x.textContent))`)
      rec('dashboard', `New dashboard button, ${label}`, has === expect ? 'PASS' : 'FAIL', `button present ${has}, expected ${expect}`)
      if (who === admin) await shot(b, 'dashboard-new-button-admin')
    } finally { await b.close() }
  }
}

// ───────────────────────────── dark theme + phone ─────────────────────────────
const KEY_PAGES = ['/tms/dashboard', '/tms/shipments', '/tms/tracking?assignee=all', '/tms/customers', '/tms/shipments/new', '/tms/invoicing']
async function theme(admin) {
  for (const [mode, width, height] of [['dark-1440', 1440, 900], ['light-390', 390, 844], ['dark-390', 390, 844]]) {
    const dark = mode.startsWith('dark')
    const storage = { ...admin.storage, 'tms-theme': dark ? 'dark' : 'light' }
    const b = await open(storage, { width, height })
    try {
      await b.setViewport(width, height)
      const issues = []
      for (const path of KEY_PAGES) {
        await b.navigate(path); await waitShell(b).catch(() => {}); await pause(6000)
        const f = await b.evaluate(`(() => {
          const de = document.documentElement; const over = de.scrollWidth - innerWidth
          let offender = null
          if (over > 1) { const els = [...document.querySelectorAll('.tms-main *, .tms-sidebar *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed'); offender = els.slice(0, 3).map((e) => e.tagName + '.' + String(e.className).split(' ')[0]) }
          const bg = getComputedStyle(document.querySelector('.tms-main') ?? document.body).backgroundColor
          return { theme: de.getAttribute('data-tms-theme'), scrollWidth: de.scrollWidth, over, offender, bg, path: location.pathname }
        })()`)
        const lum = (f.bg.match(/\d+/g) ?? [255, 255, 255]).slice(0, 3).map(Number).reduce((s, v) => s + v, 0) / 3
        if (f.over > 1) issues.push(`${path}: page overflows by ${f.over}px (${JSON.stringify(f.offender)})`)
        if (dark && (f.theme !== 'dark' || lum > 90)) issues.push(`${path}: not dark (theme ${f.theme}, bg ${f.bg})`)
        if (!dark && f.theme === 'dark') issues.push(`${path}: dark in light mode`)
        await shot(b, `theme-${mode}-${path.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`)
      }
      rec('theme', `${mode}: ${KEY_PAGES.length} key pages, no horizontal page overflow${dark ? ', dark surfaces' : ''}`, issues.length ? 'FAIL' : 'PASS', issues.length ? issues.join(' | ') : `${KEY_PAGES.length}/${KEY_PAGES.length} pages clean`)
    } finally { await b.close() }
  }
}

async function main() {
  await mkdir(SHOTS, { recursive: true })
  const admin = await ident('admin', ['ADMIN', 'page-tms'])
  let loadsOnly, viewerTms, claim
  try {
    if (want('nav')) { loadsOnly = await ident('loads', ['page-loads']); viewerTms = await ident('viewer', ['page-tms']) }
    if (want('dashboard')) { viewerTms = viewerTms ?? await ident('viewer', ['page-tms']); claim = await ident('claim', ['page-tms', 'claim-DASHBOARDS_CREATE']) }
    if (want('nav')) await nav(admin, loadsOnly, viewerTms)
    if (want('routes')) await routes(admin)
    if (want('dashboard')) await dashboard(admin, viewerTms, claim)
    if (want('drawer')) await drawer(admin)
    if (want('boards')) await boards(admin)
    if (want('theme')) await theme(admin)
  } finally {
    for (const email of mk) console.log(`identity removed: ${await deleteIdentity(email)}`)
    await writeFile('/tmp/qaui_results.json', JSON.stringify(results, null, 1)).catch(() => {})
  }
  const bad = results.filter((r) => r.status === 'FAIL')
  console.log(`\n${results.filter((r) => r.status === 'PASS').length} pass, ${bad.length} fail, ${results.filter((r) => !['PASS', 'FAIL'].includes(r.status)).length} other`)
  if (bad.length) process.exitCode = 1
}
await main()
