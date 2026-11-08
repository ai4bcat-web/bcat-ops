#!/usr/bin/env node
/**
 * Step AC2 screenshots: the dense Load Tracking and Shipments lists at 1440 and 1920 wide.
 *
 * Dev only. Needs `vite` running on http://127.0.0.1:5173 with the repo-root (production)
 * amplify_outputs.json aliased to the DEV stack's outputs. Mints one temporary admin on the dev pool,
 * deletes it at the end and checks it is gone. Staff-name columns are blurred before capture.
 *
 *   node scripts/devShotsAC2.mjs
 */
import { resolve } from 'node:path'
import { launchBrowser } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'

const ORIGIN = 'http://127.0.0.1:5173'
const OUT = resolve('Docs/tms-build/screenshots/ac2')
const email = `zz-ac2-shots-${Date.now()}@bcatcorp.com`

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

const WIDTHS = `(() => [...document.querySelectorAll('.tms-dg-table thead th')].filter((h) => h.textContent.trim() !== '' && !h.classList.contains('tms-dg-check')).map((h) => [h.textContent.trim(), Math.round(h.getBoundingClientRect().width)]))()`
const settle = async (b, ms = 2500) => { await b.pause(ms); await b.evaluate(BLUR) }
const report = {}

const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
let b
try {
  b = await launchBrowser({ origin: ORIGIN, storage: id.storage, profilePrefix: 'bcat-ac2-', purpose: 'AC2 screenshots', viewport: { width: 1440, height: 900 } })
  for (const [name, path] of [['shipments-active', '/tms/shipments'], ['intake', '/tms/shipments/intake'], ['tracking', '/tms/tracking?assignee=all']]) {
    await b.navigate(path)
    await b.waitFor('.tms-dg-scroll', 60_000)
    await settle(b, 4000)
    report[name] = await b.evaluate(WIDTHS)
    await b.screenshot(`${OUT}/AC2-${name}-grid-1440.png`)
    await b.click({ pattern: '^Columns$' })
    await settle(b, 3000)
    await b.screenshot(`${OUT}/AC2-${name}-columns-dialog-1440.png`)
    if (name === 'shipments-active') {
      await b.evaluate(`(() => { const i = document.querySelector('input[aria-label="Search columns"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'carrier'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await settle(b, 800)
      await b.screenshot(`${OUT}/AC2-${name}-columns-dialog-search-1440.png`)
    }
    await b.press('Escape')
  }
  console.log(JSON.stringify(report))
  console.log('problems', JSON.stringify(b.problems().exceptions.slice(0, 5)))
} finally {
  if (b) await b.close()
  console.log('temporary identity removed:', await deleteIdentity(email))
}
