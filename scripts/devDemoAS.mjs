#!/usr/bin/env node
// Step AS: refresh the Carrier Sales / Cover / Find & Invite demo screenshots (read-only, dev, masked, 1440x900).
import { writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchBrowser, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity, gql } from './lib/devIdentity.mjs'

const DIR = resolve('Docs/tms-build/screenshots/demo')
const MASK = `(() => {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, phone = /\\(?\\b\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b/g
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const ns = []
  while (w.nextNode()) ns.push(w.currentNode)
  for (const n of ns) { const t = n.nodeValue.replace(email, '[e-mail hidden]').replace(phone, '[phone hidden]'); if (t !== n.nodeValue) n.nodeValue = t }
})()`
const email = `zz-as-demo-${Date.now()}@example.invalid`
const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
let b
try {
  const rows = (await gql(id.token, 'query { listCarriers(limit: 1000, filter: { mcNumber: { attributeExists: true } }) { items { mcNumber status mcpStatus } } }')).listCarriers.items
  const pick = rows.find((c) => c.status === 'ACTIVE' && /ACCEPTABLE|MODERATE/.test(c.mcpStatus ?? '')) ?? rows.find((c) => c.status === 'ACTIVE')
  b = await launchBrowser({ origin: DEV_ORIGIN, storage: id.storage, profilePrefix: 'bcat-asd-', purpose: 'AS demo', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
  const has = (s) => b.evaluate(`!!document.querySelector(${JSON.stringify(s)})`)
  const shot = async (name) => { await b.evaluate(MASK); await b.screenshot(join(DIR, `${name}.png`), { clipToContent: true }) }
  const setInput = (sel, v) => b.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await b.navigate('/tms/carrier-sales'); await b.poll(() => has('[data-testid="cs-lookup-input"]'), 'lookup', 60000)
  await setInput('[data-testid="cs-lookup-input"]', pick.mcNumber); await pause(200)
  await b.evaluate(`document.querySelector('[data-testid="cs-lookup-go"]').click()`)
  await b.poll(() => has('[data-testid="cs-lookup-card"]'), 'card', 90000); await pause(800)
  await shot('08-carrier-sales-needs-cover')
  await b.poll(() => has('[data-testid="cover-row"]'), 'a load needing cover', 90000)
  await b.evaluate(`document.querySelector('[data-testid="cover-row"]').click()`)
  await b.poll(() => has('[role=dialog]'), 'cover dialog', 30000)
  await setInput('[role=dialog] input[aria-label="Carrier MC or DOT"]', pick.mcNumber); await pause(200)
  await b.evaluate(`document.querySelector('[data-testid="cover-lookup"]').click()`)
  await b.poll(() => has('[data-testid="cover-lookup-card"]'), 'cover card', 90000); await pause(800)
  await shot('08b-cover-dialog-lookup')
  await b.navigate(`/tms/carriers/find?mc=${encodeURIComponent(pick.mcNumber)}`)
  await b.poll(() => has('[data-testid="find-lookup-card"]'), 'find card', 90000); await pause(1500)
  await shot('08a-find-and-invite-lookup-read-only')
  console.log('shots written for an', pick.status, 'carrier')
} finally { await b?.close(); console.log('identity gone:', await deleteIdentity(email)) }
const p = join(DIR, 'index.txt'); let t = await readFile(p, 'utf8')
t = t.replace(/^08-carrier-sales-needs-cover\.png\t.*$/m, '08-carrier-sales-needs-cover.png\tCarrier Sales, MC lookup card (Set up with us, packet standing)')
 .replace(/^08a-find-and-invite-lookup-read-only\.png\t.*$/m, '08a-find-and-invite-lookup-read-only.png\tFind and Invite, lookup card with directory standing and actions')
 .replace(/^08b-cover-dialog-lookup\.png\t.*$/m, '08b-cover-dialog-lookup.png\tCover dialog, MC lookup card')
await writeFile(p, t)
