#!/usr/bin/env node
/**
 * Step AC screenshots: the dense Load Tracking and Shipments lists at 1440 and 1920 wide.
 *
 * Dev only. Needs `vite` running on http://127.0.0.1:5173 with the repo-root (production)
 * amplify_outputs.json aliased to the DEV stack's outputs. Mints one temporary admin on the dev pool,
 * deletes it at the end and checks it is gone. Staff-name columns are blurred before capture.
 *
 *   node scripts/devShotsAC.mjs
 */
import { resolve } from 'node:path'
import { launchBrowser } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'

const ORIGIN = 'http://127.0.0.1:5173'
const OUT = resolve('Docs/tms-build/screenshots/ac')
const email = `zz-ac-shots-${Date.now()}@bcatcorp.com`

const BLUR = `(() => {
  const people = ['Tracker', 'Sales Rep', 'Driver', 'Customer rep', 'Dispatcher']
  const heads = [...document.querySelectorAll('thead th')]
  const idx = heads.map((h, i) => (people.some((p) => h.textContent.trim().startsWith(p)) ? i : -1)).filter((i) => i >= 0)
  document.querySelectorAll('tbody tr').forEach((tr) => idx.forEach((i) => { const td = tr.children[i]; if (td) td.style.filter = 'blur(5px)' }))
  document.querySelectorAll('.tms-tracking-group-title, .tms-user-text').forEach((el) => { el.style.filter = 'blur(5px)' })
})()`

const FIT = `(() => {
  const scroll = document.querySelector('.tms-dg-scroll')
  const box = scroll.getBoundingClientRect()
  const heads = [...scroll.querySelectorAll('thead th')]
  const data = heads.filter((h) => !h.classList.contains('tms-dg-check') && h.textContent.trim() !== '')
  const fits = data.filter((h) => h.getBoundingClientRect().right <= box.right + 1)
  return { total: data.length, fit: fits.length, names: fits.map((h) => h.textContent.trim()), scrollWidth: scroll.scrollWidth, viewport: Math.round(box.width), rows: document.querySelectorAll('tbody tr:not(.tms-dg-spacer)').length }
})()`

const settle = async (b, ms = 2500) => { await b.pause(ms); await b.evaluate(BLUR) }
const report = {}

const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
let b
try {
  b = await launchBrowser({ origin: ORIGIN, storage: id.storage, profilePrefix: 'bcat-ac-', purpose: 'AC screenshots', viewport: { width: 1440, height: 900 } })
  for (const [w, h] of [[1440, 900], [1920, 1080]]) {
    await b.setViewport(w, h)
    for (const [name, path] of [['shipments-active', '/tms/shipments'], ['shipments-all', '/tms/shipments?list=all'], ['intake', '/tms/shipments/intake'], ['tracking', '/tms/tracking?assignee=all']]) {
      await b.navigate(path)
      await b.waitFor('.tms-dg-scroll', 60_000)
      await settle(b, 4000)
      report[`${name}@${w}`] = await b.evaluate(FIT)
      await b.screenshot(`${OUT}/AC-${name}-${w}.png`)
    }
    // Tracking: summary strip open, a header filter open, comfortable density.
    await b.navigate('/tms/tracking?assignee=all')
    await b.waitFor('.tms-dg-scroll', 60_000)
    await settle(b, 3000)
    await b.click({ pattern: '^Summary$' })
    await b.click({ label: '^Filter Status$' })
    await settle(b, 800)
    await b.screenshot(`${OUT}/AC-tracking-summary-filter-${w}.png`)
    await b.click({ text: 'Comfortable' })
    await b.press('Escape')
    await settle(b, 800)
    await b.screenshot(`${OUT}/AC-tracking-comfortable-${w}.png`)
    await b.click({ text: 'Compact' })
    await b.click({ pattern: '^Summary$' })
  }
  await b.setViewport(1440, 900)
  await b.navigate('/tms/tracking?assignee=all')
  await b.waitFor('.tms-dg-scroll', 60_000)
  await settle(b, 3000)
  await b.evaluate(`document.querySelector('.tms-sidebar').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('.tms-sidebar').dispatchEvent(new MouseEvent('mouseenter'))`)
  await settle(b, 600)
  await b.screenshot(`${OUT}/AC-sidebar-rail-open-1440.png`)
  console.log(JSON.stringify(report, null, 2))
  console.log('problems', JSON.stringify(b.problems().exceptions.slice(0, 5)))
} finally {
  if (b) await b.close()
  console.log('temporary identity removed:', await deleteIdentity(email))
}
