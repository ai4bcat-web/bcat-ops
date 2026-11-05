#!/usr/bin/env node
/**
 * Step AC follow-up verification: the dense grids (Shipments Active / All / Intake, Load Tracking,
 * Customers, Carriers) on the DEPLOYED dev app, against Ryne's rules.
 *
 *   node scripts/devVerifyAC2.mjs --inventory      list the boards and checks; no network, no browser
 *   node scripts/devVerifyAC2.mjs                  the live walk on the dev app (read-only)
 *   node scripts/devVerifyAC2.mjs --only=tracking  one board (shipments-active, shipments-all, intake, tracking, customers, carriers)
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyAC2.mjs
 *
 * Dev only. Mints one throwaway ADMIN on the dev pool (zz-ac2-<ts>), deletes it and proves it gone in
 * `finally`. Never prints a name, e-mail, token or cell text: counts and booleans only. The walk only
 * changes this temp user's own layout prefs (localStorage) and never clicks a row action. The one
 * exception is the Customers activity step: it creates a ZZ customer plus zz-ac2- invoices/shipments in
 * the dev tables (suffix-guarded) and removes them again in `finally`.
 *
 * Per board it checks:  rows render | header filters (type-ahead / multi-select + select all + clear /
 * date range / numeric range) | popovers on the last columns stay inside the window, close on outside
 * click and Escape and never scroll the page | click-to-sort (asc, desc) | sticky header + sticky first
 * column (computed style, and held while scrolled sideways) | Columns dialog (two panes, reorder, width)
 * persisted across a reload | density toggle persists | sidebar is the icon rail and there is no side
 * filter panel | default columns visible without horizontal scroll at 1440 and 1920 (counts).
 *
 * Screenshots: Docs/tms-build/screenshots/ac2/<board>-<width>.png
 */
import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'

const SHOTS = resolve('Docs/tms-build/screenshots/ac2')
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length)

/**
 * One entry per dense list page. ACCustomers / ACCarriers own their entries: set `path` to the
 * page. Every board, Shipments Active / All included, must fit its default columns at 1440 and 1920
 * without horizontal scroll (the Shipments default is the short Aljex-order set, see
 * SHIPMENT_DEFAULT_COLUMNS).
 */
const BOARDS = [
  { id: 'shipments-active', title: 'Shipments Active', path: '/tms/shipments' },
  { id: 'shipments-all', title: 'Shipments All', path: '/tms/shipments?list=all' },
  { id: 'intake', title: 'Intake', path: '/tms/shipments/intake' },
  { id: 'tracking', title: 'Load Tracking', path: '/tms/tracking?assignee=all' },
  { id: 'customers', title: 'Customers', path: '/tms/customers' },
  { id: 'carriers', title: 'Carriers', path: '/tms/carriers' },
]

const CHECKS = [
  'rows', 'sticky', 'rail', 'no-filter-panel', 'fit-1440', 'fit-1920',
  'filter-text', 'filter-multi', 'filter-select-all-clear', 'filter-date', 'filter-number',
  'popover-last-columns', 'sort', 'columns-dialog', 'columns-persist', 'density-persist',
  'customers-activity-columns (Open AR + Last shipment: ZZ fixtures, Columns dialog, p95 latency)',
]

const report = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(5)} ${name}${detail ? `: ${detail}` : ''}`)
}
const exists = (file) => access(resolve(file)).then(() => true, () => false)

// ── In-page helpers (strings: evaluated in the app tab; return plain data, never cell text) ──────

const ROWS = `'tbody tr:not(.tms-dg-spacer):not(.tms-dg-group)'`

/** Rows in the list (the virtualised window is padded by spacers, so count by table height). */
const ROW_COUNT = `(() => {
  const table = document.querySelector('.tms-dg-table'); if (!table) return -1
  const head = table.querySelector('thead').offsetHeight
  const first = table.querySelector(${ROWS})
  if (!first) return 0
  const h = first.getBoundingClientRect().height || 30
  const groups = table.querySelectorAll('tbody tr.tms-dg-group').length
  const body = table.offsetHeight - head
  return Math.max(0, Math.round(body / h) - groups)
})()`

const FIT = `(() => {
  const scroll = document.querySelector('.tms-dg-scroll'); if (!scroll) return null
  const box = scroll.getBoundingClientRect()
  const heads = [...scroll.querySelectorAll('thead th')].filter((h) => !h.classList.contains('tms-dg-check') && h.textContent.trim() !== '')
  const fit = heads.filter((h) => h.getBoundingClientRect().right <= box.right + 1).length
  return { total: heads.length, fit, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, hScroll: scroll.scrollWidth > scroll.clientWidth + 1 }
})()`

const HEADERS = `[...document.querySelectorAll('.tms-dg-scroll thead th')].filter((h) => !h.classList.contains('tms-dg-check')).map((h) => h.querySelector('.tms-dg-th-label')?.textContent.trim() ?? '')`

const WIDTHS = `Object.fromEntries([...document.querySelectorAll('.tms-dg-scroll thead th')].filter((h) => !h.classList.contains('tms-dg-check')).map((h) => [h.querySelector('.tms-dg-th-label')?.textContent.trim() ?? '', Math.round(h.getBoundingClientRect().width)]))`

const FILTER_LABELS = `[...document.querySelectorAll('.tms-dg-scroll thead .tms-dg-filter-btn')].map((b) => b.getAttribute('aria-label').replace(/^Filter /, ''))`

const STICKY = `(() => {
  const scroll = document.querySelector('.tms-dg-scroll'); if (!scroll) return null
  const th = scroll.querySelector('thead th'); const ths = [...scroll.querySelectorAll('thead th')]
  const firstData = ths.find((h) => !h.classList.contains('tms-dg-check'))
  const td = scroll.querySelector('tbody tr:not(.tms-dg-spacer) td.tms-dg-sticky:not(.tms-dg-check)')
  const hs = getComputedStyle(firstData), cs = td ? getComputedStyle(td) : null
  const start = scroll.scrollLeft
  scroll.scrollLeft = scroll.scrollWidth
  const moved = scroll.scrollLeft - start
  const box = scroll.getBoundingClientRect()
  const held = firstData.getBoundingClientRect().left - box.left
  const heldCell = td ? td.getBoundingClientRect().left - box.left : null
  const body = scroll.querySelector('tbody'); const savedTop = scroll.scrollTop
  scroll.scrollTop = 200
  const headTop = th.getBoundingClientRect().top - box.top
  scroll.scrollTop = savedTop; scroll.scrollLeft = start
  return { headerSticky: hs.position === 'sticky', headerTop: hs.top, firstColSticky: hs.position === 'sticky' && hs.left !== 'auto', cellSticky: cs?.position === 'sticky', movedPx: Math.round(moved), heldLeft: Math.round(held), heldCellLeft: heldCell == null ? null : Math.round(heldCell), headStaysAtTop: Math.abs(headTop) <= 1 }
})()`

const RAIL = `(() => {
  const shell = document.querySelector('.tms-shell'); const side = document.querySelector('.tms-sidebar')
  const panel = document.querySelector('.tms-filter-panel, .tms-board-filters, aside.tms-board-aside, [data-testid="board-filters"], [aria-label="Board filters"]')
  const leftPanels = [...document.querySelectorAll('aside')].filter((a) => !a.classList.contains('tms-sidebar') && a.getBoundingClientRect().width > 120 && a.getBoundingClientRect().left < 400)
  return { collapsed: !!shell?.classList.contains('tms-is-collapsed'), dense: !!shell?.classList.contains('tms-dense'), sidebarWidth: side ? Math.round(side.getBoundingClientRect().width) : null, filterPanel: !!panel || leftPanels.length > 0 }
})()`

const SET_VALUE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true
})()`

const POPOVER = `(() => {
  const p = document.querySelector('.tms-dg-popover'); if (!p) return null
  const r = p.getBoundingClientRect()
  return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
    text: !!p.querySelector('input[type=text]'), date: p.querySelectorAll('input[type=date]').length, number: p.querySelectorAll('input[type=number]').length,
    checks: p.querySelectorAll('input[type=checkbox]').length, selectAll: [...p.querySelectorAll('button')].some((b) => /^select all/i.test(b.textContent.trim())),
    clear: [...p.querySelectorAll('button')].some((b) => /^clear/i.test(b.textContent.trim())), scrolls: p.scrollHeight > p.clientHeight + 1 }
})()`

// ── Driver helpers ───────────────────────────────────────────────────────────────────────────────

const rowCount = (b) => b.evaluate(ROW_COUNT)
const settle = (b, ms = 800) => b.pause(ms)

async function openBoard(b, board, width = 1440) {
  await b.setViewport(width, width >= 1920 ? 1080 : 900)
  await b.navigate(board.path)
  await b.waitFor('.tms-dg-scroll', 60_000)
  // Rows (or the empty state) are in: a spinner-only first paint has no table body yet.
  await b.poll(async () => (await rowCount(b)) >= 0, 'grid body', 30_000)
  // The working set lands in stages (first partial after a few seconds): wait for real rows, up to 30 s.
  await b.poll(async () => (await rowCount(b)) > 0, 'rows', 30_000).catch(() => {})
  await settle(b, 1500)
}

const closePopover = async (b) => { await b.press('Escape'); await settle(b, 250) }

async function openFilter(b, label) {
  await closePopover(b)
  await b.click({ label: `^Filter ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` })
  await settle(b, 300)
  return b.evaluate(POPOVER)
}

async function mouseClick(b, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }
  await b.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await b.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await b.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

const firstCellText = (b, headerLabel) => b.evaluate(`(() => {
  const ths = [...document.querySelectorAll('.tms-dg-scroll thead th')]
  const i = ths.findIndex((h) => h.querySelector('.tms-dg-th-label')?.textContent.trim() === ${JSON.stringify(headerLabel)})
  if (i < 0) return ''
  for (const tr of document.querySelectorAll(${ROWS})) { const t = tr.children[i]?.getAttribute('title') || tr.children[i]?.textContent.trim(); if (t) return t }
  return ''
})()`)

const columnTexts = (b, headerLabel, n = 8) => b.evaluate(`(() => {
  const ths = [...document.querySelectorAll('.tms-dg-scroll thead th')]
  const i = ths.findIndex((h) => h.querySelector('.tms-dg-th-label')?.textContent.trim() === ${JSON.stringify(headerLabel)})
  return [...document.querySelectorAll(${ROWS})].slice(0, ${n}).map((tr) => (tr.children[i]?.textContent.trim() ?? ''))
})()`)

// ── Per-board checks ─────────────────────────────────────────────────────────────────────────────

async function checkRows(b, board) {
  const n = await rowCount(b)
  const heads = await b.evaluate(HEADERS)
  if (n > 0) line('PASS', `${board.id} rows`, `${n} rows, ${heads.length} columns`)
  else line('FAIL', `${board.id} rows`, `no rows rendered (count ${n})`)
  return n
}

async function checkChrome(b, board) {
  const sticky = await b.evaluate(STICKY)
  const ok = sticky && sticky.headerSticky && sticky.headStaysAtTop && sticky.firstColSticky && sticky.cellSticky && (sticky.movedPx === 0 || Math.abs(sticky.heldCellLeft - sticky.heldLeft) <= 1)
  line(ok ? 'PASS' : 'FAIL', `${board.id} sticky header + first column`, JSON.stringify(sticky))
  const rail = await b.evaluate(RAIL)
  line(rail.collapsed && rail.dense && rail.sidebarWidth <= 100 ? 'PASS' : 'FAIL', `${board.id} sidebar icon rail`, JSON.stringify(rail))
  line(rail.filterPanel ? 'FAIL' : 'PASS', `${board.id} no side filter panel`)
}

async function checkFit(b, board, width) {
  await openBoard(b, board, width)
  const fit = await b.evaluate(FIT)
  const rows = await rowCount(b)
  await b.screenshot(`${SHOTS}/${board.id}-${width}.png`)
  if (fit && fit.hScroll) line('INFO', `${board.id} column widths @${width}`, JSON.stringify(await b.evaluate(WIDTHS)))
  const ok = fit && !fit.hScroll
  line(ok ? 'PASS' : 'FAIL', `${board.id} default columns without horizontal scroll @${width}`, `${fit?.fit}/${fit?.total} columns within view, scrollWidth ${fit?.scrollWidth} vs ${fit?.clientWidth}, ${rows} rows`)
  return fit
}

async function checkFilters(b, board, rows0) {
  const labels = await b.evaluate(FILTER_LABELS)
  if (labels.length === 0) { line('FAIL', `${board.id} header filters`, 'no header filter buttons'); return }
  const kinds = { text: [], multi: [], date: [], number: [] }
  for (const label of labels) {
    const p = await openFilter(b, label)
    if (!p) continue
    const kind = p.date ? 'date' : p.number ? 'number' : p.text ? 'text' : 'multi'
    kinds[kind].push(label)
    await closePopover(b)
  }
  line('INFO', `${board.id} filter kinds`, `text ${kinds.text.length}, multi ${kinds.multi.length}, date ${kinds.date.length}, number ${kinds.number.length}`)

  // type-ahead narrows: type the first 3 characters of a visible value
  const textLabel = kinds.text[0]
  if (!textLabel) line('SKIP', `${board.id} filter-text`, 'no text column')
  else {
    const sample = (await firstCellText(b, textLabel)).slice(0, 3)
    if (sample.length < 2) line('SKIP', `${board.id} filter-text`, 'no sample value')
    else {
      await openFilter(b, textLabel)
      await b.evaluate(SET_VALUE('.tms-dg-popover input[type=text]', sample))
      await settle(b, 600)
      const after = await rowCount(b)
      line(after >= 1 && after <= rows0 ? 'PASS' : 'FAIL', `${board.id} filter-text`, `type-ahead on a ${textLabel} column: ${rows0} -> ${after} rows`)
      await b.evaluate(`[...document.querySelectorAll('.tms-dg-popover .tms-dg-filter-clear')].forEach((x) => x.click())`)
      await closePopover(b)
      line((await rowCount(b)) === rows0 ? 'PASS' : 'FAIL', `${board.id} filter-text clears`, 'rows restored')
    }
  }

  // multi-select: pick one option, then select all, then clear
  const multiLabel = kinds.multi[0]
  if (!multiLabel) { line('SKIP', `${board.id} filter-multi`, 'no multi-select column'); line('SKIP', `${board.id} filter-select-all-clear`, 'no multi-select column') } else {
    const p = await openFilter(b, multiLabel)
    if (!p.checks) line('FAIL', `${board.id} filter-multi`, `${multiLabel}: popover offers no checkboxes (type-ahead tag picker?)`)
    else {
      // the option the most rows carry (a fixed option can have none): picking it must keep those rows
      const picked = await b.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('.tms-dg-popover input[type=checkbox]')].filter((x) => !/^exclude$/i.test(x.closest('label')?.textContent.trim() ?? ''))
        if (!boxes.length) return 0
        const count = (x) => Number(x.closest('label')?.querySelector('.tms-dg-filter-count')?.textContent ?? 0)
        boxes.sort((x, y) => count(y) - count(x))[0].click(); return boxes.length })()`)
      await settle(b, 500)
      const one = await rowCount(b)
      line(one >= 1 && one <= rows0 ? 'PASS' : 'FAIL', `${board.id} filter-multi`, `${multiLabel}: ${picked} options, one picked: ${rows0} -> ${one} rows`)
      const withAll = await openFilter(b, multiLabel).catch(() => null)
      const pop = (await b.evaluate(POPOVER)) ?? withAll
      let allOk = false
      if (pop?.selectAll) {
        await b.evaluate(`[...document.querySelectorAll('.tms-dg-popover button')].find((x) => /^select all/i.test(x.textContent.trim()))?.click()`)
        await settle(b, 500)
        const checked = await b.evaluate(`[...document.querySelectorAll('.tms-dg-popover input[type=checkbox]')].filter((x) => x.checked && !/^exclude$/i.test(x.closest('label')?.textContent.trim() ?? '')).length`)
        await b.evaluate(`[...document.querySelectorAll('.tms-dg-popover button')].find((x) => /^clear/i.test(x.textContent.trim()))?.click()`)
        await settle(b, 500)
        const cleared = await rowCount(b)
        allOk = checked >= 1 && cleared === rows0
        line(allOk ? 'PASS' : 'FAIL', `${board.id} filter-select-all-clear`, `select all ticked ${checked}; Clear restored ${cleared}/${rows0} rows`)
      } else line('FAIL', `${board.id} filter-select-all-clear`, 'no "Select all" control in the picker')
      await b.evaluate(`[...document.querySelectorAll('.tms-dg-popover button')].find((x) => /^clear/i.test(x.textContent.trim()))?.click()`)
      await closePopover(b)
    }
  }

  // date range: a window far in the future matches nothing, clearing restores
  if (!kinds.date[0]) line('SKIP', `${board.id} filter-date`, 'no date column')
  else {
    await openFilter(b, kinds.date[0])
    await b.evaluate(SET_VALUE('.tms-dg-popover input[type=date]', '2999-01-01'))
    await settle(b, 600)
    const none = await rowCount(b)
    await b.evaluate(`document.querySelector('.tms-dg-popover .tms-dg-filter-clear')?.click()`)
    await settle(b, 400)
    const back = await rowCount(b)
    line(none === 0 && back === rows0 ? 'PASS' : 'FAIL', `${board.id} filter-date`, `${kinds.date[0]} from 2999: ${none} rows; cleared: ${back}/${rows0}`)
    await closePopover(b)
  }

  // numeric range
  if (!kinds.number[0]) line('SKIP', `${board.id} filter-number`, 'no numeric column')
  else {
    await openFilter(b, kinds.number[0])
    await b.evaluate(SET_VALUE('.tms-dg-popover input[type=number]', '999999999'))
    await settle(b, 600)
    const none = await rowCount(b)
    await b.evaluate(`document.querySelector('.tms-dg-popover .tms-dg-filter-clear')?.click()`)
    await settle(b, 400)
    const back = await rowCount(b)
    line(none === 0 && back === rows0 ? 'PASS' : 'FAIL', `${board.id} filter-number`, `${kinds.number[0]} min 999999999: ${none} rows; cleared: ${back}/${rows0}`)
    await closePopover(b)
  }
  return labels
}

/** Last columns: scroll the grid to the far right, open the last filters; each popover stays in the window, closes on outside click and Escape, and never scrolls the page. */
async function checkPopovers(b, board, labels) {
  if (labels.length === 0) return
  await b.evaluate(`(() => { const s = document.querySelector('.tms-dg-scroll'); s.scrollLeft = s.scrollWidth })()`)
  await settle(b, 300)
  const tail = labels.slice(-3)
  const issues = []
  const pageBefore = await b.evaluate(`({ y: scrollY, h: document.documentElement.scrollHeight, vh: innerHeight })`)
  for (const label of tail) {
    const p = await openFilter(b, label)
    if (!p) { issues.push(`${label}: did not open`); continue }
    if (!p.inside) issues.push(`${label}: popover outside window (${p.left},${p.top})-(${p.right},${p.bottom}) in ${p.vw}x${p.vh}`)
    const scrollAfterOpen = await b.evaluate(`scrollY`)
    if (scrollAfterOpen !== pageBefore.y) issues.push(`${label}: opening scrolled the page`)
    // outside click on the page title bar area (not the grid, not the popover)
    await mouseClick(b, 4, 4)
    await settle(b, 250)
    if (await b.evaluate(`!!document.querySelector('.tms-dg-popover')`)) issues.push(`${label}: stays open after an outside click`)
    await openFilter(b, label)
    await b.press('Escape'); await settle(b, 250)
    if (await b.evaluate(`!!document.querySelector('.tms-dg-popover')`)) issues.push(`${label}: stays open after Escape`)
  }
  // a real sideways wheel scroll (CDP mouseWheel deltaX) closes, not strands, an open popover; boards with no overflow have nothing to scroll
  const overflow = await b.evaluate(`(() => { const s = document.querySelector('.tms-dg-scroll'); return s.scrollWidth > s.clientWidth + 1 })()`)
  if (overflow) {
    const label = tail[tail.length - 1]
    await b.evaluate(`(() => { const s = document.querySelector('.tms-dg-scroll'); s.scrollLeft = 0 })()`)
    await settle(b, 400)
    await openFilter(b, label)
    const at = await b.evaluate(`(() => { const r = document.querySelector('.tms-dg-scroll').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    const farRight = await b.evaluate(`document.querySelector('.tms-dg-scroll').scrollLeft`)
    const wheel = b.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: -300, deltaY: 0 })
    await Promise.race([wheel, b.pause(5000)]).catch(() => {})
    // opening the last filter scrolled the grid to its far right: wheel back left; fall back to a programmatic scroll when the wheel never lands
    const moved = () => b.evaluate(`document.querySelector('.tms-dg-scroll').scrollLeft < ${farRight} - 1`)
    await b.poll(moved, 'sideways wheel scroll', 3000).catch(async () => { await b.evaluate(`document.querySelector('.tms-dg-scroll').scrollLeft = ${farRight} - 300`) })
    // headless Chrome emits scroll events on frames and makes none after a CDP key press: a screenshot forces one
    await b.command('Page.captureScreenshot', { format: 'jpeg', quality: 10 }).catch(() => {})
    // a heavy board repaints slowly after a scroll: give the close up to 8 s
    await b.poll(() => b.evaluate(`!document.querySelector('.tms-dg-popover')`), 'popover closed by scroll', 8000).catch(() => {})
    if (await b.evaluate(`!!document.querySelector('.tms-dg-popover')`)) issues.push('popover stays open (detached from its header) after a real sideways scroll ' + JSON.stringify(await b.evaluate(`({ sl: document.querySelector('.tms-dg-scroll').scrollLeft, far: ${farRight}, pops: [...document.querySelectorAll('.tms-dg-popover')].map((x) => x.getAttribute('aria-label') + '@' + Math.round(x.getBoundingClientRect().left)), label: ${JSON.stringify(label)} })`)))
  }
  await closePopover(b)
  const pageAfter = await b.evaluate(`({ y: scrollY, h: document.documentElement.scrollHeight })`)
  if (pageAfter.h > pageAfter.y + pageBefore.vh + 2 && pageAfter.h > pageBefore.h) issues.push('page grew while a popover was open')
  line(issues.length === 0 ? 'PASS' : 'FAIL', `${board.id} popover-last-columns`, issues.length ? issues.join(' | ') : `last ${tail.length} filters inside the window, close on outside click + Escape + sideways scroll, page unmoved`)
}

async function checkSort(b, board) {
  const target = await b.evaluate(`(() => {
    const ths = [...document.querySelectorAll('.tms-dg-scroll thead th')]
    for (const th of ths.slice(0, 8)) { const label = th.querySelector('.tms-dg-th-label')?.textContent.trim(); if (label && th.querySelector('.tms-dg-sort') && !th.getAttribute('aria-sort')) return label }
    return null })()`)
  if (!target) { line('FAIL', `${board.id} sort`, 'no sortable header'); return }
  const sortBy = async () => {
    await b.evaluate(`[...document.querySelectorAll('.tms-dg-scroll thead .tms-dg-sort')].find((x) => x.textContent.trim() === ${JSON.stringify(target)})?.click()`)
    await settle(b, 500)
    return b.evaluate(`[...document.querySelectorAll('.tms-dg-scroll thead th')].find((h) => h.querySelector('.tms-dg-th-label')?.textContent.trim() === ${JSON.stringify(target)})?.getAttribute('aria-sort')`)
  }
  const first = await sortBy(); const colA = await columnTexts(b, target)
  const second = await sortBy(); const colD = await columnTexts(b, target)
  // a third click returns to unsorted; leave the grid as found
  await sortBy()
  const asc = first === 'ascending' && second === 'descending'
  const reordered = JSON.stringify(colA) !== JSON.stringify(colD) || colA.every((v) => v === colA[0])
  line(asc && reordered ? 'PASS' : 'FAIL', `${board.id} sort`, `${target}: aria-sort ${first} -> ${second}; first rows differ asc vs desc: ${JSON.stringify(colA) !== JSON.stringify(colD)}`)
}

async function readLayout(b) {
  return { headers: await b.evaluate(HEADERS), widths: await b.evaluate(WIDTHS), density: await b.evaluate(`document.querySelector('.tms-dg')?.getAttribute('data-density')`) }
}

async function checkColumns(b, board) {
  const before = await readLayout(b)
  const opened = await b.click({ text: 'Columns' }).then(() => true, () => false)
  if (!opened) { line('FAIL', `${board.id} columns-dialog`, 'no Columns button'); return }
  await b.waitFor('.tms-cd-panes', 10_000).catch(() => {})
  const panes = await b.evaluate(`({ panes: document.querySelectorAll('.tms-cd-pane').length, available: !!document.querySelector('[aria-label="Available fields"]'), chosen: !!document.querySelector('[aria-label="Chosen columns"]'), chosenRows: document.querySelectorAll('[data-testid="cd-chosen"] .tms-cd-row').length })`)
  line(panes.panes === 2 && panes.available && panes.chosen ? 'PASS' : 'FAIL', `${board.id} columns-dialog`, `two panes, ${panes.chosenRows} chosen columns`)
  if (panes.chosenRows < 3) { await b.click({ text: 'Cancel' }).catch(() => {}); line('FAIL', `${board.id} columns-persist`, 'too few chosen columns to reorder'); return }
  // reorder: move the 3rd chosen column up one (keyboard on the grip), widen the 2nd by 40px
  const moved = await b.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="cd-chosen"] .tms-cd-row')]
    const name = rows[2].querySelector('.tms-cd-name').textContent.trim()
    const grip = rows[2].querySelector('.tms-cd-grip'); grip.focus()
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    return name })()`)
  await settle(b, 300)
  const widened = await b.evaluate(`(() => {
    const input = document.querySelector('[data-testid="cd-chosen"] .tms-cd-row:nth-child(2) input.tms-cd-width')
    const name = input.closest('.tms-cd-row').querySelector('.tms-cd-name').textContent.trim()
    const next = Number(input.value) + 40
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, String(next)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
    return { name, next } })()`)
  await settle(b, 200)
  await b.click({ text: 'Apply' })
  await settle(b, 800)
  const applied = await readLayout(b)
  const orderOk = applied.headers.indexOf(moved) === before.headers.indexOf(moved) - 1
  const widthOk = Math.abs((applied.widths[widened.name] ?? 0) - widened.next) <= 2
  // reload: the layout is the user's, not the session's
  await b.reload()
  await b.waitFor('.tms-dg-scroll', 60_000)
  await settle(b, 3000)
  const reloaded = await readLayout(b)
  const persisted = JSON.stringify(reloaded.headers) === JSON.stringify(applied.headers) && Math.abs((reloaded.widths[widened.name] ?? 0) - widened.next) <= 2
  line(orderOk && widthOk ? 'PASS' : 'FAIL', `${board.id} columns apply`, `reorder ${orderOk ? 'applied' : 'NOT applied'}, width ${widthOk ? 'applied' : 'NOT applied'}`)
  line(persisted ? 'PASS' : 'FAIL', `${board.id} columns-persist`, `order + width survive a reload: ${persisted}`)
  // put the temp user's layout back (Reset in the dialog is not on every board: re-apply the original order and widths)
  await b.click({ text: 'Columns' }).catch(() => {})
  await settle(b, 600)
  await b.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="cd-chosen"] .tms-cd-row')]
    const name = ${JSON.stringify(moved)}
    const idx = rows.findIndex((r) => r.querySelector('.tms-cd-name').textContent.trim() === name)
    if (idx >= 0) { const grip = rows[idx].querySelector('.tms-cd-grip'); grip.focus(); grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) }
  })()`)
  await settle(b, 200)
  await b.click({ text: 'Apply' }).catch(() => {})
  await settle(b, 600)
}

async function checkDensity(b, board) {
  const start = (await readLayout(b)).density
  const other = start === 'compact' ? 'Comfortable' : 'Compact'
  await b.click({ text: other }).catch(() => {})
  await settle(b, 500)
  const changed = (await readLayout(b)).density
  await b.reload()
  await b.waitFor('.tms-dg-scroll', 60_000)
  await settle(b, 3000)
  const after = (await readLayout(b)).density
  line(changed !== start && after === changed ? 'PASS' : 'FAIL', `${board.id} density-persist`, `${start} -> ${changed}, after reload ${after}`)
  await b.click({ text: start === 'compact' ? 'Compact' : 'Comfortable' }).catch(() => {})
  await settle(b, 300)
}

/** Carriers only (asked for by the Carriers page owner): status tabs carry counts, a row opens the profile, Find & invite is linked. */
async function checkCarriersExtras(b, board) {
  const tabs = await b.evaluate(`[...document.querySelectorAll('button, [role=tab]')].map((x) => x.textContent.trim()).filter((t) => /^(Pending|Active|Inactive)/i.test(t))`)
  line(tabs.length >= 3 && tabs.every((t) => /\d/.test(t)) ? 'PASS' : 'FAIL', `${board.id} status tabs with counts`, JSON.stringify(tabs))
  const find = await b.evaluate(`!![...document.querySelectorAll('a')].find((a) => /\\/tms\\/carriers\\/find$/.test(a.getAttribute('href') ?? ''))`)
  line(find ? 'PASS' : 'FAIL', `${board.id} Find & invite link`)
  const opened = await b.evaluate(`(() => { const tr = document.querySelector(${ROWS}); if (!tr) return null; tr.click(); return true })()`)
  await settle(b, 1500)
  const where = await b.evaluate(`({ path: location.pathname, panel: !!document.querySelector('[role=dialog], .tms-drawer, .tms-carrier-profile') })`)
  line(opened && (where.path !== '/tms/carriers' || where.panel) ? 'PASS' : 'FAIL', `${board.id} row opens the profile`, JSON.stringify(where))
  await b.navigate(board.path)
  await b.waitFor('.tms-dg-scroll', 60_000)
  await settle(b, 2500)
}

async function walkBoard(b, board) {
  console.log(`\n== ${board.title} (${board.path}) ==`)
  await openBoard(b, board, 1440)
  const rows = await checkRows(b, board)
  await checkChrome(b, board)
  const labels = rows > 0 ? await checkFilters(b, board, rows) : []
  await checkPopovers(b, board, labels ?? [])
  if (rows > 0) await checkSort(b, board)
  await checkColumns(b, board)
  await checkDensity(b, board)
  if (board.id === 'carriers') await checkCarriersExtras(b, board)
  const fit1440 = await checkFit(b, board, 1440)
  const fit1920 = await checkFit(b, board, 1920)
  await b.setViewport(1440, 900)
  line('INFO', `${board.id} default columns`, `1440: ${fit1440?.fit}/${fit1440?.total} in view; 1920: ${fit1920?.fit}/${fit1920?.total} in view`)
}

// ── Customers: Open AR + Last shipment (CRM_LIST_ACCOUNTS withActivity) ──────────────────────────

const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
/** A dev table by model; refuses anything that is not the dev stack's. */
const devTable = (model) => {
  const name = `${model}-${DEV_SUFFIX}`
  if (!name.endsWith(`-${DEV_SUFFIX}`) || name.includes(PROD_SUFFIX)) throw new Error(`refusing non-dev table ${name}`)
  return name
}
const pct = (values, p) => { const s = [...values].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] }

/**
 * Guarded fixtures: a ZZ customer (through the directory router) with two open invoices (1,234.56 + 43.21)
 * and two shipments, written straight to the dev tables under zz-ac2- ids and deleted in the caller's
 * `finally`. Expected cells: Open AR $1,278, Last shipment 2026-03-14 (the later pickup).
 */
async function createActivityFixtures(token, ts) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb')
  const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb')
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
  const dir = routerAs(token, 'tmsDirectoryActions')
  const name = `ZZ AC2 Activity ${ts}`
  const customer = await dir('UPSERT_CUSTOMER', { name, billingEmail: 'ac2-verification@example.invalid', notes: 'Dev-only AC2 verification fixture. Safe to delete.' }).then((r) => r.customer ?? r)
  const customerId = String(customer.id)
  const now = new Date().toISOString()
  const put = (model, item) => doc.send(new PutCommand({ TableName: devTable(model), Item: { __typename: model, createdAt: now, updatedAt: now, ...item } }))
  const owned = { Invoice: [], Shipment: [] }
  const invoice = async (n, balanceCents) => {
    const id = `zz-ac2-${ts}-inv${n}`
    await put('Invoice', { id, number: id, orderId: `zz-ac2-${ts}-ord`, customerId, status: 'ISSUED', arOpen: 'OPEN', balanceCents, dueAt: '2099-01-01T00:00:00.000Z', issuedAt: now })
    owned.Invoice.push(id)
  }
  const shipment = async (n, pickupAppt) => {
    const id = `zz-ac2-${ts}-ship${n}`
    await put('Shipment', { id, number: `ZZAC2-${ts}-${n}`, customerId, status: 'CANCELED', pickupAppt, deletedAt: now })
    owned.Shipment.push(id)
  }
  await invoice(1, 123_456)
  await invoice(2, 4_321)
  await shipment(1, '2026-01-05T15:00:00.000Z')
  await shipment(2, '2026-03-14T15:00:00.000Z')
  return { customerId, name, owned, doc }
}

async function removeActivityFixtures(fx, token) {
  const { DeleteCommand, GetCommand } = await import('@aws-sdk/lib-dynamodb')
  let gone = true
  for (const [model, ids] of Object.entries(fx.owned)) {
    for (const id of ids) {
      if (!id.startsWith('zz-ac2-')) { gone = false; continue }
      await fx.doc.send(new DeleteCommand({ TableName: devTable(model), Key: { id } })).catch(() => {})
      if ((await fx.doc.send(new GetCommand({ TableName: devTable(model), Key: { id } })).catch(() => ({ Item: 1 }))).Item) gone = false
    }
  }
  const dir = routerAs(token, 'tmsDirectoryActions')
  const row = (await gql(token, `query { getCustomer(id: ${JSON.stringify(fx.customerId)}) { id updatedAt active } }`, {})).getCustomer
  if (row && row.active !== false) await dir('ARCHIVE_CUSTOMER', { id: fx.customerId, expectedUpdatedAt: String(row.updatedAt) }).catch(() => {})
  const after = (await gql(token, `query { getCustomer(id: ${JSON.stringify(fx.customerId)}) { active } }`, {})).getCustomer
  return gone && after?.active === false
}

async function checkCustomerActivity(b, board, token, fx) {
  // Server contract + latency: the same call the page makes, from the temp ADMIN.
  const crm = routerAs(token, 'tmsCrmActions')
  const timed = async (input) => { const t0 = performance.now(); const out = await crm('CRM_LIST_ACCOUNTS', input); return { ms: performance.now() - t0, out } }
  const plain = await timed({ scope: 'all' })
  const cold = await timed({ scope: 'all', withActivity: true })
  const mine = cold.out.rows.find((r) => r.customerId === fx.customerId)
  line(mine?.openArCents === 127_777 && mine?.lastShipmentAt === '2026-03-14T15:00:00.000Z' ? 'PASS' : 'FAIL', `${board.id} CRM_LIST_ACCOUNTS withActivity`, `rows ${cold.out.rows.length}, fixture openArCents match ${mine?.openArCents === 127_777}, lastShipmentAt match ${mine?.lastShipmentAt === '2026-03-14T15:00:00.000Z'}`)
  line(plain.out.rows.every((r) => !('openArCents' in r)) ? 'PASS' : 'FAIL', `${board.id} activity is opt-in`, 'no openArCents without withActivity')
  const warm = []
  for (let i = 0; i < 9; i += 1) warm.push((await timed({ scope: 'all', withActivity: true })).ms)
  line('INFO', `${board.id} withActivity latency (ms)`, `first call ${Math.round(cold.ms)} (cold when no other call in the last 60 s; includes AppSync + Lambda), 9 cached p95 ${Math.round(pct(warm, 95))}, plain list ${Math.round(plain.ms)}, ${cold.out.rows.length} accounts`)

  // The page: add both columns through the Columns dialog, then read the ZZ row.
  await openBoard(b, board, 1440)
  await b.click({ text: 'Columns' })
  await b.waitFor('.tms-cd-panes', 10_000).catch(() => {})
  const added = await b.evaluate(`(() => { const ids = ['tms-cd-openAr', 'tms-cd-lastShipment']; const boxes = ids.map((i) => document.getElementById(i)); if (boxes.some((x) => !x)) return false; boxes.forEach((x) => { if (!x.checked) x.click() }); return true })()`)
  await settle(b, 300)
  await b.click({ text: 'Apply' })
  await settle(b, 800)
  line(added ? 'PASS' : 'FAIL', `${board.id} Open AR / Last shipment in the Columns dialog`, `available and addable: ${added}`)
  const heads = await b.evaluate(HEADERS)
  line(heads.includes('Open AR') && heads.includes('Last shipment') ? 'PASS' : 'FAIL', `${board.id} activity headers`, `Open AR ${heads.includes('Open AR')}, Last shipment ${heads.includes('Last shipment')}`)
  await b.evaluate(SET_VALUE('input[aria-label="Search customers"]', fx.name))
  await settle(b, 1500)
  const read = () => b.evaluate(`(() => {
    const ths = [...document.querySelectorAll('.tms-dg-scroll thead th')]
    const col = (l) => ths.findIndex((h) => h.querySelector('.tms-dg-th-label')?.textContent.trim() === l)
    const tr = [...document.querySelectorAll(${ROWS})].find((r) => r.textContent.includes(${JSON.stringify(fx.name)}))
    if (!tr) return null
    return { ar: tr.children[col('Open AR')]?.textContent.trim(), last: tr.children[col('Last shipment')]?.textContent.trim() }
  })()`)
  let cells = await read()
  if (!cells) { await b.click({ text: 'Prospects' }).catch(() => {}); await settle(b, 800); cells = await read() }
  line(cells?.ar === '$1,278' && cells?.last === '2026-03-14' ? 'PASS' : 'FAIL', `${board.id} ZZ row shows open AR and last shipment`, `row found ${!!cells}, Open AR ok ${cells?.ar === '$1,278'}, Last shipment ok ${cells?.last === '2026-03-14'}`)
  // put the temp user's layout back
  await b.click({ text: 'Columns' }).catch(() => {})
  await settle(b, 600)
  await b.evaluate(`['tms-cd-openAr', 'tms-cd-lastShipment'].forEach((i) => { const x = document.getElementById(i); if (x?.checked) x.click() })`)
  await b.click({ text: 'Apply' }).catch(() => {})
  await settle(b, 400)
}

async function inventory() {
  for (const board of BOARDS) line('INFO', `board ${board.id}`, `${board.title} ${board.path}`)
  line('INFO', 'checks', CHECKS.join(', '))
  let ok = true
  for (const file of ['src/features/tms/grid/DenseGrid.tsx', 'src/features/tms/grid/DenseFilterPopover.tsx', 'src/features/tms/grid/ColumnsDialog.tsx', 'scripts/lib/cdpBrowser.mjs', 'scripts/lib/devIdentity.mjs']) {
    if (!(await exists(file))) { line('FAIL', `file ${file}`, 'missing'); ok = false }
  }
  if (ok) line('PASS', 'inventory', `${BOARDS.length} boards x ${CHECKS.length} checks`)
  return ok
}

async function main() {
  if (flag('inventory')) { process.exitCode = (await inventory()) ? 0 : 1; return }
  const origin = process.env.DEV_VERIFY_UI_URL || DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`origin ${origin} is not an allowed dev origin`)
  await mkdir(SHOTS, { recursive: true })
  const boards = BOARDS.filter((x) => !only || x.id === only)
  if (boards.length === 0) throw new Error(`no board matches --only=${only}`)
  const email = `zz-ac2-${Date.now()}@bcatcorp.com`
  const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
  let b
  try {
    b = await launchBrowser({ origin, storage: id.storage, profilePrefix: 'bcat-ac2-', purpose: 'AC2 verification', viewport: { width: 1440, height: 900 } })
    for (const board of boards) {
      try { await walkBoard(b, board) } catch (err) { line('FAIL', `${board.id} walk`, String(err.message).slice(0, 200)) }
      if (board.id === 'customers') {
        let fx
        try {
          fx = await createActivityFixtures(id.token, Date.now())
          await checkCustomerActivity(b, board, id.token, fx)
        } catch (err) { line('FAIL', `${board.id} activity columns`, String(err.message).slice(0, 200)) }
        finally {
          if (fx) {
            const clean = await removeActivityFixtures(fx, id.token).catch(() => false)
            line(clean ? 'PASS' : 'FAIL', `${board.id} ZZ activity fixtures removed`, 'zz-ac2- invoices/shipments deleted, customer archived')
          }
        }
      }
    }
    const exceptions = b.problems().exceptions
    line(exceptions.length === 0 ? 'PASS' : 'FAIL', 'page exceptions', `${exceptions.length}`)
  } finally {
    if (b) await b.close()
    const gone = await deleteIdentity(email)
    console.log(`temporary identity removed: ${gone}`)
    if (!gone) process.exitCode = 1
  }
  const failed = report.filter((r) => r.status === 'FAIL')
  console.log(`\n${report.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${report.filter((r) => r.status === 'SKIP').length} skipped`)
  if (failed.length) process.exitCode = 1
}

await main()
