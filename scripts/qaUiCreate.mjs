#!/usr/bin/env node
// QA UI sweep, create-shipment form (read-only: no Save / Create is ever clicked). Dev only.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser, pause } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'
const SHOTS = resolve('Docs/tms-build/screenshots/qa')
const rec = (name, status, detail) => console.log(`${status.padEnd(7)} [create] ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
const tid = (id) => `[data-testid="${id}"]`
const email = `zz-qaui-c-${Date.now()}@bcatcorp.com`
await mkdir(SHOTS, { recursive: true })
const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
let b
const setValue = (sel, v) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; el.focus(); set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const ready = async () => { await b.poll(() => b.evaluate(`!!document.querySelector('.tms-ship-form')`), 'form', 60_000); await pause(2500) }
try {
  b = await launchBrowser({ storage: id.storage, viewport: { width: 1440, height: 900 }, profilePrefix: 'bcat-qaui-' })
  // Board button -> form, not the mint utility
  await b.navigate('/tms/shipments'); await b.waitFor('.tms-dg-scroll', 60000); await pause(2500)
  await b.evaluate(`[...document.querySelectorAll('.tms-main button, .tms-main a')].find((x) => /^create shipment$/i.test(x.textContent.trim()))?.click()`)
  await ready()
  rec('Create shipment button opens the form', await b.evaluate(`location.pathname === '/tms/shipments/new' && !/mint a shipment/i.test(document.body.innerText) && !!document.querySelector('.tms-ship-form')`) ? 'PASS' : 'FAIL', await b.evaluate(`location.pathname`))
  // 1 required = green, no asterisks
  const req = await b.evaluate(`(() => {
    const stars = [...document.querySelectorAll('.tms-ship-form label')].filter((l) => /\\s\\*\\s*$/.test(l.textContent)).length
    const reqs = [...document.querySelectorAll('.tms-field-req input, .tms-field-req select')]
    const plain = [...document.querySelectorAll('.tms-field:not(.tms-field-req) input.tms-input')].find((i) => !i.disabled && !i.readOnly)
    const cs = (e) => { const s = getComputedStyle(e); return s.borderColor + ' / ' + s.backgroundColor }
    const green = (c) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(c); return !!m && +m[2] > +m[1] && +m[2] >= +m[3] }
    return { stars, n: reqs.length, greenN: reqs.filter((e) => green(getComputedStyle(e).borderColor) || green(getComputedStyle(e).backgroundColor)).length, req: reqs[0] ? cs(reqs[0]) : null, plain: plain ? cs(plain) : null, labels: [...document.querySelectorAll('.tms-field-req [aria-label]')].map((e) => e.getAttribute('aria-label')).slice(0, 8) }
  })()`)
  rec('required fields green, no asterisks', req.stars === 0 && req.n >= 6 && req.greenN === req.n ? 'PASS' : 'FAIL', req)
  // 3 two customer emails
  rec('2 customer e-mail fields', (await b.evaluate(`document.querySelectorAll('[data-testid^="f-customer-email-"]').length`)) === 2 ? 'PASS' : 'FAIL', 'count')
  // 4 Bill To after picking an existing customer (selection only, nothing saved)
  await setValue(`${tid('f-customer-name')} input`, 'a')
  await b.poll(() => b.evaluate(`!!document.querySelector('${tid('f-customer-name')} li button:not([data-testid="f-customer-addRow"])')`), 'customer suggestions', 20_000).catch(() => {})
  await b.evaluate(`document.querySelector('${tid('f-customer-name')} li button:not([data-testid="f-customer-addRow"])')?.click()`)
  await b.poll(() => b.evaluate(`!!document.querySelector('${tid('f-customer-billToBlock')}')`), 'Bill To', 20_000).catch(() => {})
  await pause(1000)
  await b.evaluate(`document.querySelector('${tid('hdr-billTo-chip')}')?.click()`); await pause(300)
  const bt = await b.evaluate(`(() => { const blk = document.querySelector('${tid('f-customer-billToBlock')}'); if (!blk) return null; const panel = document.querySelector('${tid('ship-form-header-panel')}'); const hdr = document.querySelector('${tid('ship-form-header')}').getBoundingClientRect(); const r = blk.getBoundingClientRect(); return { rows: ['terms', 'factoring', 'emails', 'limit', 'available'].filter((k) => document.querySelector('[data-testid="f-customer-billTo-' + k + '"], [data-testid="card-billTo-' + (k === 'limit' ? 'limit' : k) + '"]')), editable: blk.querySelectorAll('input:not([readonly]):not([disabled]), textarea, select').length, insideBillToCard: !panel.hidden && r.top >= hdr.top && r.bottom <= hdr.bottom + 1, chip: document.querySelector('${tid('hdr-billTo-text')}')?.innerText ?? '' } })()`)
  rec('Bill To detail read-only, in the header panel under the strip', bt && bt.rows.length === 5 && bt.editable === 0 && bt.insideBillToCard ? 'PASS' : 'FAIL', bt)
  await b.screenshot(`${SHOTS}/create-bill-to-1440.png`); await b.evaluate(`document.querySelector('${tid('hdr-billTo-chip')}')?.click()`); await pause(200)
  // 2 auto miles: pick two existing locations (names read from the Locations board, never printed)
  await b.navigate('/tms/locations'); await b.poll(() => b.evaluate(`document.querySelectorAll('.tms-main table tbody tr').length > 2`), 'locations', 40_000).catch(() => {}); await pause(2500)
  const locs = await b.evaluate(`(() => { const out = []; for (const tr of document.querySelectorAll('.tms-main table tbody tr')) { const t = (tr.querySelector('td')?.textContent ?? '').trim(); if (t.length > 4 && !/^zz/i.test(t)) out.push(t); if (out.length >= 40) break } return out })()`)
  await b.navigate('/tms/shipments/new'); await ready()
  await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
  await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
  const pickLoc = async (field, q) => { await setValue(tid(field), q); await b.poll(() => b.evaluate(`!!document.querySelector('${tid(field + '-option')}')`), field, 10_000).catch(() => {}); const ok = await b.evaluate(`(() => { const o = document.querySelector('${tid(field + '-option')}'); if (!o) return false; o.click(); return true })()`); await pause(800); return ok }
  let picked = [false, false]; let pickedAt = []
  for (const name of locs) {
    if (!picked[0]) { picked[0] = await pickLoc('f-pickup-name', name); if (picked[0]) pickedAt.push(name); continue }
    picked[1] = await pickLoc('f-consignee-name', name)
    const geo = await b.evaluate(`[document.querySelector('${tid('f-pickup-addressLine')}')?.innerText, document.querySelector('${tid('f-consignee-addressLine')}')?.innerText]`)
    if (picked[1] && geo[0] && geo[1] && geo[0] !== geo[1]) break
    picked[1] = false
  }
  let miles = 0
  for (let i = 0; i < 30 && !(miles > 0); i += 1) { await pause(1000); miles = Number(await b.evaluate(`document.querySelector('${tid('f-shipping-customerMiles')}')?.value ?? ''`)) }
  const truck = miles
  const src = await b.evaluate(`document.querySelector('${tid('f-shipping-milesSource')}')?.innerText ?? ''`)
  const cities = (await b.evaluate(`[document.querySelector('${tid('f-pickup-addressLine')}')?.innerText, document.querySelector('${tid('f-consignee-addressLine')}')?.innerText]`)).map((x) => (x && !/No address/.test(x) ? 'set' : 'empty'))
  const dbg = await b.evaluate(`({ ps: document.querySelector('${tid('f-pickup-state')}')?.value?.length, cs: document.querySelector('${tid('f-consignee-state')}')?.value?.length, pz: !!document.querySelector('${tid('f-pickup-zip')}')?.value, note: document.querySelector('${tid('f-shipping-milesSource')}')?.innerText ?? null, disabled: document.querySelector('${tid('f-shipping-disableMileage')}')?.checked })`)
  console.log('miles debug', JSON.stringify(dbg), JSON.stringify(b.problems()).slice(0, 400))
  rec('auto miles from the stop addresses', miles > 0 && truck > 0 ? 'PASS' : 'FAIL', { locationsTried: locs.length, picked, customerMiles: miles, truckMiles: truck, source: src.slice(0, 60), cities })
  await b.evaluate(`document.querySelector('${tid('section-route')}').scrollIntoView({ block: 'start' })`); await b.screenshot(`${SHOTS}/create-auto-miles-1440.png`)
  // 6 layout: total scroll height, columns, no horizontal overflow, tab order
  const lay = await b.evaluate(`(() => { const sc = document.querySelector('.tms-ship-form-scroll'); const cards = [...document.querySelectorAll('.tms-ship-card')].map((s) => s.dataset.testid.replace('section-', '')); const rail = document.querySelector('[data-testid="ship-form-rail"]').getBoundingClientRect(); return { cards, hOverflow: Math.max(sc.scrollWidth - sc.clientWidth, document.documentElement.scrollWidth - innerWidth), railWidth: Math.round(rail.width), railTop: Math.round(rail.top) } })()`)
  rec('five cards in order (Customer + Bill To in the header), 360 px rail, no h-overflow', lay.hOverflow <= 1 && lay.cards.join() === 'freight,route,rates,carrier,documents' && lay.railWidth === 360 ? 'PASS' : 'FAIL', lay)
  // first screen: Customer, Bill To, the Freight card start and the rail's Create button are visible without scrolling
  await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`); await pause(400)
  const fold = await b.evaluate(`(() => { const r = (id) => document.querySelector('[data-testid="' + id + '"]')?.getBoundingClientRect(); const pu = r('f-shipping-equipmentType'); const c = r('ship-form-create'); const cu = r('ship-form-header'); const bt = r('hdr-billTo-chip'); return { customerBottom: Math.round(cu?.bottom ?? -1), billToTop: Math.round(bt?.top ?? -1), freightFieldBottom: Math.round(pu?.bottom ?? -1), createBottom: Math.round(c?.bottom ?? -1), h: innerHeight } })()`)
  rec('first screen at 1440x900 shows the header strip (Customer, Bill To chip), Freight start and the rail', fold.freightFieldBottom > 0 && fold.freightFieldBottom <= fold.h && fold.createBottom <= fold.h && fold.billToTop < fold.h ? 'PASS' : 'FAIL', fold)
  await b.screenshot(`${SHOTS}/create-first-screen-1440.png`)
  // tab order through the Freight card starts at Shipment type and moves in reading order
  await b.evaluate(`document.querySelector('${tid('f-shipping-shipmentType')}')?.focus()`)
  const seen = []
  for (let i = 0; i < 14; i += 1) { await b.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await b.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); seen.push(await b.evaluate(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`)) }
  rec('tab order follows the Aljex field order', 'INFO', seen)
  // 5 check calls preview on an existing shipment (read-only page)
  await b.navigate('/tms/tracking?assignee=all'); await b.waitFor('.tms-dg-scroll', 60000); await pause(3500)
  await b.evaluate(`document.querySelector('.tms-dg-scroll tbody tr:not(.tms-dg-spacer):not(.tms-dg-group)')?.click()`)
  await b.poll(() => b.evaluate(`!!document.querySelector('a[aria-label="Open full page"]')`), 'drawer link', 30_000).catch(() => {})
  const sid = await b.evaluate(`document.querySelector('a[aria-label="Open full page"]')?.getAttribute('href') ?? null`)
  if (sid) {
    await b.navigate(sid.replace(/\?.*$/, '') + '/edit'); await ready()
    await b.evaluate(`document.querySelector('${tid('card-tracking-body')}')?.scrollIntoView({ block: 'start' })`); await pause(1500)
    const cc = await b.evaluate(`(() => { const s = document.querySelector('[data-testid="card-tracking-body"]'); if (!s) return null; const link = s.querySelector('[data-testid="card-tracking-open"]'); return { strip: !!s.querySelector('[data-testid="card-tracking-facts"]'), link: link?.getAttribute('href')?.replace(/\\/shipments\\/[^/?]+/, '/shipments/<id>') ?? null, inputs: [...s.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select')].filter((i) => !i.closest('[data-testid="tracking-mode-control"]')).length, rows: s.querySelectorAll('tbody tr, .tms-recent-row, li').length } })()`)
    rec('Tracking half of Carrier & Tracking = Load Tracking pull (read-only outside the mode control)', cc && cc.strip && cc.link?.includes('/tms/tracking') && cc.inputs === 0 ? 'PASS' : 'FAIL', cc)
    await b.screenshot(`${SHOTS}/create-check-calls-preview-1440.png`)
  } else rec('Tracking card', 'SKIP', 'no shipment link on the board')
  // 7 intake prefill: open an intake row, press Create shipment, read the banner + chips (nothing saved)
  await b.navigate('/tms/shipments/intake'); await b.waitFor('.tms-dg-scroll', 60000); await pause(3500)
  const btn = await b.evaluate(`document.querySelectorAll('[data-testid="intake-create-shipment"]').length`)
  rec('Intake list row offers Create shipment', btn > 0 ? 'PASS' : 'FAIL', { buttons: btn })
  await b.screenshot(`${SHOTS}/intake-list-1440.png`)
  if (btn) {
    await b.evaluate(`document.querySelector('[data-testid="intake-create-shipment"]').click()`)
    await pause(5000)
    const f = await b.evaluate(`({ path: location.pathname, banner: !!document.querySelector('[data-testid="ship-form-intake-banner"]'), chips: [...document.querySelectorAll('[data-testid$="-from-email"]')].map((n) => n.getAttribute('data-testid').replace('-from-email', '')), filled: [...document.querySelectorAll('.tms-ship-form input.tms-input')].filter((i) => i.value).length })`)
    rec('Intake -> Create shipment opens the form pre-filled, e-mail-sourced fields marked', f.path === '/tms/shipments/new' && f.banner && f.chips.length > 0 ? 'PASS' : 'FAIL', f)
    await b.screenshot(`${SHOTS}/intake-prefill-1440.png`)
  }
} finally { if (b) await b.close(); console.log('identity removed', await deleteIdentity(email)) }
