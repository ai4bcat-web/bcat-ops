#!/usr/bin/env node
/**
 * Step AH verification against the DEV site (or `npm run dev` on localhost): the Create-shipment button bug and
 * the Aljex-parity create / edit form (AH-plan §2, §12).
 *
 *   node scripts/devVerifyAH.mjs [--inventory] [--only=<substring>]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAH.mjs
 *
 *   --inventory  no network, no browser: every AH id has a runner, every action the steps call exists in its Lambda
 *                handler, every data-testid a step selects exists in the source, both routes are registered
 *                (App.tsx, devVerifyS2 ROUTES, AA_HOMES) and nothing imports the deleted CreateShipmentDialog.
 *   --only=      run only the steps whose id contains the substring (fixtures are still created).
 *
 * RUNS ONLY AFTER THE DEPLOY (the form saves through the AH backend actions). Dev only: refuses any AppSync endpoint
 * but the dev one, any staff pool but the dev pool and any origin outside ALLOWED_ORIGINS. No SSM writes, no main /
 * production, no invoice_*.json, no Aljex export. Two throwaway identities (zz-ah-admin-<ts> ADMIN, zz-ah-tms-<ts> with
 * only page-tms) are created and deleted (and proven gone) in `finally`; passwords and tokens are never printed.
 *
 * Everything it creates is ZZ AH …: one customer, one carrier, four locations. In `finally` every shipment of the ZZ
 * customer is VOIDED (never deleted: PROs are permanent), the customer and locations are archived, the carrier is set
 * INACTIVE. Output carries ids and counts only, never names, e-mails or phones of real directory rows.
 *
 * "Mint a shipment for a load" (Settings › Company › Data & backups) is only READ here: its Create button mints a
 * permanent PRO for a real legacy load, so the step checks the card renders and its buttons are enabled, nothing more.
 *
 * Screenshots: Docs/tms-build/screenshots/ah/<nn>-<slug>-L.png (light theme, 1600 px wide so the Aljex grid shows),
 * one image per section, listed in index.txt.
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { AA_HOMES } from './lib/aaRoutes.mjs'
import { requiredPatterns, missingFromRoutes } from './devVerifyS2.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const SHOTS = resolve('Docs/tms-build/screenshots/ah')
const VOID_REASON = 'AH harness'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: {}, only })
const { line, report, written, problemList, waitLoaded, matches } = walk

const SECTIONS = [
  ['shipping', 'Shipping Requirements'], ['customer', 'Customer'], ['pickup', 'Pick Up'], ['consignee', 'Consignee'],
  ['history', 'Historical Rates'], ['roles', 'Roles'], ['more', 'More Information'], ['rates', 'Rates'],
  ['carrier', 'Carrier Information'], ['picks', 'Picks & Stops'], ['documents', 'Documents'], ['checkCalls', 'Check Calls'],
]

/** Every AH id, in run order. All need the browser; AH08-AH14 also write to dev. */
export const AH_STEPS = [
  { id: 'AH01', slug: 'board-create-button' },
  { id: 'AH02', slug: 'tracking-create-button' },
  { id: 'AH03', slug: 'mint-card' },
  { id: 'AH04', slug: 'sections-render' },
  { id: 'AH05', slug: 'sections-collapse' },
  { id: 'AH06', slug: 'validation' },
  { id: 'AH07', slug: 'local-draft' },
  { id: 'AH08', slug: 'draft-customer-only' },
  { id: 'AH09', slug: 'create-full' },
  { id: 'AH10', slug: 'saved-fields' },
  { id: 'AH11', slug: 'edit-roundtrip' },
  { id: 'AH12', slug: 'submit-order' },
  { id: 'AH13', slug: 'edit-live' },
  { id: 'AH14', slug: 'cover-entry' },
]

// ───────────────────────────── selectors (every literal id here is checked by --inventory) ─────────────────────────────
const tid = (id) => `[data-testid="${id}"]`
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const failures = (list) => { if (list.length) throw new Error(list.slice(0, 4).join(' | ')) }

/** Parse ids out of labels.ts (single source of Aljex wording): the harness never retypes a label. */
async function labelFacts() {
  const text = await readFile(resolve('src/features/shipments/form/labels.ts'), 'utf8')
  const ids = new Set()
  for (const m of text.matchAll(/def\('(\w+)',\s*'([\w-]+)'/g)) ids.add(`f-${m[1]}-${m[2]}`)
  for (let n = 1; n <= 6; n += 1) ids.add(`f-customer-email-${n}`)
  const list = (name) => {
    const at = text.indexOf(`${name} = [`)
    return at < 0 ? [] : [...text.slice(at, text.indexOf(']', at)).matchAll(/'(\w+)'/g)].map((m) => m[1])
  }
  const flagsAt = text.indexOf('FLAG_COLUMNS')
  const flagBlock = text.slice(flagsAt, text.indexOf('} as const', flagsAt))
  const flags = [...flagBlock.matchAll(/'(\w+)'/g)].map((m) => m[1])
  return { ids, shippingOrder: list('SHIPPING_TAB_ORDER'), flags }
}

// ───────────────────────────── inventory (no network, no browser) ─────────────────────────────
async function sourceFiles(dir) {
  const out = []
  for (const entry of await readdir(resolve(dir), { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(full))
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
  return out
}

const HANDLERS = {
  shipAs: 'amplify/functions/tms-shipment-actions/handler.ts',
  dir: 'amplify/functions/tms-directory-actions/handler.ts',
  car: 'amplify/functions/tms-carrier-actions/handler.ts',
}

/** Gates: (1) ids registered, (2) actions exist, (3) testids exist, (4) routes registered, (5) old dialog gone. */
export async function inventory() {
  const self = await readFile(resolve('scripts/devVerifyAH.mjs'), 'utf8')
  const runners = Object.keys(RUNNERS)
  const registered = AH_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: AH ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  line('PASS', 'gate 1: AH ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner`)

  const cases = {}
  for (const [key, file] of Object.entries(HANDLERS)) {
    const text = await readFile(resolve(file), 'utf8')
    cases[key] = new Set([...text.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]))
  }
  const missingActions = []
  let actionCount = 0
  for (const m of self.matchAll(/\b(shipAs\.admin|ctx\.dir|ctx\.car)\('([A-Z_]+)'/g)) {
    const key = m[1] === 'shipAs.admin' ? 'shipAs' : m[1] === 'ctx.dir' ? 'dir' : 'car'
    actionCount += 1
    if (!cases[key].has(m[2])) missingActions.push(`${m[2]} (${HANDLERS[key]})`)
  }
  if (missingActions.length) { line('FAIL', 'gate 2: every action the steps call exists', missingActions.join('; ')); return false }
  line('PASS', 'gate 2: every action the steps call exists', `${actionCount} call sites, all with a handler case`)

  const facts = await labelFacts()
  const sources = [
    ...await sourceFiles('src/features/shipments/form'),
    'src/features/shipments/ShipmentsBoard.tsx',
    'src/features/shipments/components/ShipmentDetail.tsx',
    'src/features/tms/brokerage/company/components/MintShipmentCard.tsx',
  ]
  const haystack = (await Promise.all(sources.map((f) => readFile(resolve(f), 'utf8')))).join('\n')
  const ids = new Set([...self.matchAll(/\btid\('([^'$]+)'\)/g)].map((m) => m[1]))
  const derived = new Set([...facts.ids, ...facts.flags.map((k) => `f-shipping-flag-${k}`)])
  const absent = [...ids].filter((id) => !derived.has(id) && !haystack.includes(`"${id}"`) && !haystack.includes(`'${id}'`) && !haystack.includes(`\`${id}\``))
  // `section-<key>[-toggle]`, `rates-line-<i>` and `f-<prefix>-<field>` are built from a variable in the source: check the stem.
  const stems = [
    [/^section-[A-Za-z]+-toggle$/, 'section-${id}-toggle'], [/^section-[A-Za-z]+$/, 'section-${id}'],
    [/^rates-line-\d+$/, 'rates-line-${i}'], [/^f-(pickup|consignee|stop-\d)-/, '`f-${prefix}-'],
  ]
  const unresolved = absent.filter((id) => !stems.some(([re, stem]) => re.test(id) && haystack.includes(stem)))
  if (unresolved.length) { line('FAIL', 'gate 3: every data-testid a step selects exists', unresolved.join(', ')); return false }
  const labelMiss = [...SECTIONS.map(([k]) => `section-${k}-toggle`)].filter((id) => !haystack.includes('section-${id}-toggle') && !haystack.includes(id))
  if (labelMiss.length) { line('FAIL', 'gate 3: section toggles', labelMiss.join(', ')); return false }
  line('PASS', 'gate 3: every data-testid a step selects exists', `${ids.size} literal ids, ${facts.ids.size} label-derived ids, ${facts.flags.length} flags, ${SECTIONS.length} section toggles`)

  const app = await readFile(resolve('src/App.tsx'), 'utf8')
  const problems = []
  for (const p of ['shipments/new', 'shipments/:id/edit']) if (!app.includes(`path="${p}"`)) problems.push(`App.tsx has no route ${p}`)
  const s2 = missingFromRoutes(await requiredPatterns())
  if (s2.length) problems.push(`devVerifyS2 ROUTES lacks: ${s2.join(', ')}`)
  for (const p of ['/tms/shipments/new', '/tms/shipments/:id/edit']) if (!AA_HOMES.some((h) => h.pattern === p)) problems.push(`AA_HOMES lacks ${p}`)
  if (problems.length) { line('FAIL', 'gate 4: both routes registered', problems.join('; ')); return false }
  line('PASS', 'gate 4: both routes registered', 'App.tsx, devVerifyS2 ROUTES, AA_HOMES')

  const importers = []
  for (const file of await sourceFiles('src')) {
    const text = await readFile(resolve(file), 'utf8')
    if (/CreateShipmentDialog/.test(text)) importers.push(file)
  }
  if (importers.length) { line('FAIL', 'gate 5: the mint dialog is gone', importers.join(', ')); return false }
  line('PASS', 'gate 5: the old CreateShipmentDialog is gone', 'no source file mentions it')
  return true
}

// ───────────────────────────── browser helpers ─────────────────────────────
const bodyText = (b) => b.evaluate('document.body.innerText')
const pathOf = (b) => b.evaluate('location.pathname')
const has = (b, selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)

/** Set a React-controlled input / textarea / select found by `selector`, firing the events React listens to. */
async function setValue(b, selector, value) {
  const hit = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    if (el.disabled) return 'disabled';
    el.scrollIntoView({ block: 'center' });
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`set ${selector}: ${hit}`)
}
const fill = (b, id, value) => setValue(b, tid(id), value)
const fillAria = (b, label, value) => setValue(b, `[aria-label=${JSON.stringify(label)}]`, value)

async function clickSel(b, selector) {
  const hit = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'no-element'; if (el.disabled) return 'disabled'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok' })()`)
  if (hit !== 'ok') throw new Error(`click ${selector}: ${hit}`)
}
const click = (b, id) => clickSel(b, tid(id))

/** Tick a checkbox found by test id unless it is already ticked or disabled. Returns false when it is disabled. */
async function check(b, id) {
  const hit = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(tid(id))}); if (!el) return 'no-element'; if (el.disabled) return 'disabled'; if (!el.checked) { el.scrollIntoView({ block: 'center' }); el.click() } return el.checked ? 'ok' : 'unchecked' })()`)
  if (hit === 'disabled') return false
  if (hit !== 'ok') throw new Error(`check ${id}: ${hit}`)
  return true
}

/** Select the first real (non-empty) option of a <select>. Returns the chosen value. */
async function selectFirst(b, id) {
  const value = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(tid(id))}); return el ? ([...el.options].find((o) => o.value && !o.disabled)?.value ?? null) : null })()`)
  if (!value) throw new Error(`select ${id}: no real option`)
  await fill(b, id, value)
  return value
}

/** Type into a directory picker / typeahead and click its first suggestion. */
async function pickFrom(b, inputSelector, optionSelector, text) {
  await setValue(b, inputSelector, text)
  await b.poll(() => has(b, optionSelector), `suggestion for ${optionSelector}`, 15_000)
  await clickSel(b, optionSelector)
  await pause(300)
}
const CUSTOMER_OPTION = `${tid('f-customer-name')} li button`

const localDt = (dayOffset, hh, mm = 0) => {
  const d = new Date(Date.now() + dayOffset * 86_400_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`
}

async function openForm(b, path) {
  await b.navigate(path)
  await b.poll(() => has(b, tid('ship-form')), `${path} form`, 60_000).catch(async (err) => { throw new Error(`${err.message} (page: ${JSON.stringify((await bodyText(b)).replace(/\s+/g, ' ').slice(0, 200))})`) })
  await pause(800)
}

async function shotFile(b, name) {
  const file = join(SHOTS, `${name}-L.png`)
  await b.screenshot(file)
  written.push(file)
}

async function openInIdentity(ctx, storage, prefix, fn) {
  const b = await launchBrowser({ origin: ctx.origin, storage, profilePrefix: prefix, purpose: 'AH verification', viewport: { width: 1600, height: 1400, deviceScaleFactor: 1 } })
  try { return await fn(b) } finally { await b.close() }
}

const getBundle = (ctx, shipmentId) => ctx.shipAs.admin('GET_SHIPMENT_BUNDLE', { shipmentId })
const shipmentIdFromPath = (path) => /^\/tms\/shipments\/([^/]+)\/edit$/.exec(path)?.[1] ?? null

async function waitEditUrl(ctx, b, label) {
  await b.poll(async () => shipmentIdFromPath(await pathOf(b)) !== null || await has(b, tid('ship-form-partial')) || await has(b, tid('ship-form-issues')), `${label}: edit URL`, 60_000)
  const id = shipmentIdFromPath(await pathOf(b))
  if (!id) throw new Error(`${label}: stayed on the form (${JSON.stringify((await bodyText(b)).replace(/\s+/g, ' ').slice(0, 260))})`)
  ctx.shipmentIds.add(id)
  return id
}

// ───────────────────────────── steps ─────────────────────────────
const RUNNERS = {
  async AH01(ctx) {
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-ah-tms-', async (b) => {
      await b.navigate('/tms/shipments'); await waitLoaded(b)
      await b.poll(() => has(b, tid('create-shipment')), 'Create shipment button', 45_000)
      await shotFile(b, '01-board-create-button')
      await click(b, 'create-shipment')
      await b.poll(async () => (await pathOf(b)) === '/tms/shipments/new', 'route /tms/shipments/new', 20_000)
      await b.poll(() => has(b, tid('ship-form')), 'the Aljex form', 60_000)
      const text = await bodyText(b)
      expect(!/Mint a Shipment/i.test(text), 'the mint-a-load utility opened')
      expect(!(await has(b, '[role="dialog"]')), 'a dialog opened over the form')
      return 'page-tms user (no ADMIN) opened /tms/shipments/new from the board button'
    })
  },

  async AH02(ctx) {
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-ah-trk-', async (b) => {
      await b.navigate('/tms/tracking'); await waitLoaded(b)
      await b.click({ pattern: 'Create Shipment' })
      await b.poll(async () => (await pathOf(b)) === '/tms/shipments/new', 'route /tms/shipments/new', 20_000)
      expect(!/Mint a Shipment/i.test(await bodyText(b)), 'the mint-a-load utility opened')
      return 'Load tracking button opens /tms/shipments/new'
    })
  },

  async AH03(ctx) {
    const b = ctx.b
    await b.navigate('/tms/brokerage/company/data'); await waitLoaded(b)
    await b.poll(() => has(b, tid('mint-shipment-card')), 'Mint shipment card', 45_000)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('mint-shipment-card'))}).scrollIntoView({ block: 'center' })`)
    await shotFile(b, '03-settings-data-mint-card')
    const facts = await b.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(tid('mint-shipment-card'))});
      const rows = [...card.querySelectorAll('[data-testid="mint-row"]')];
      return { title: /Mint a shipment for a load/i.test(card.innerText), rows: rows.length, enabled: rows.filter((r) => { const x = r.querySelector('button'); return x && !x.disabled }).length, empty: /Every load already has a shipment/.test(card.innerText), refused: /Only an owner or admin/.test(card.innerText) };
    })()`)
    expect(facts.title, 'the card has no "Mint a shipment for a load" title')
    expect(!facts.refused, 'an ADMIN was told only an owner or admin can mint')
    expect(facts.rows > 0 ? facts.enabled === facts.rows : facts.empty, 'the card shows neither mintable loads with enabled buttons nor the empty text')
    return `card present; ${facts.rows} loads without a shipment, ${facts.enabled} with an enabled Create (not clicked: it mints a permanent PRO)`
  },

  async AH04(ctx) {
    const b = ctx.b
    const facts = await labelFacts()
    await b.setViewport(1600, 1400)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    for (const [key, title] of SECTIONS) {
      const head = await b.evaluate(`document.querySelector(${JSON.stringify(tid(`section-${key}-toggle`))})?.innerText ?? null`)
      if (!head || !head.includes(title)) bad.push(`section ${key}: heading ${JSON.stringify(head)} lacks "${title}"`)
    }
    const reds = ['Equipment (required)', 'Revenue Type (required)', 'Weight (required)', 'Description (required)', 'Name (required)', 'Ready (required)']
    for (const label of reds) if (!(await has(b, `[aria-label=${JSON.stringify(label)}]`))) bad.push(`red-required control "${label}" is missing`)
    const absent = []
    for (const id of facts.shippingOrder.map((k) => `f-shipping-${k}`)) if (!(await has(b, tid(id)))) absent.push(id)
    for (const k of facts.flags) if (!(await has(b, tid(`f-shipping-flag-${k}`)))) absent.push(`f-shipping-flag-${k}`)
    if (absent.length) bad.push(`missing controls: ${absent.join(', ')}`)

    // Tab walk: the Shipping Requirements controls are reached in labels.ts order.
    const order = facts.shippingOrder.map((k) => `f-shipping-${k}`)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid(order[0]))})?.focus()`)
    const seen = []
    for (let i = 0; i < order.length + 12; i += 1) {
      await b.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
      await b.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
      seen.push(await b.evaluate(`document.activeElement?.getAttribute('data-testid') ?? ''`))
    }
    const walked = [order[0], ...seen].filter((id, i, all) => order.includes(id) && all.indexOf(id) === i)
    const expected = order.filter((id) => walked.includes(id))
    if (walked.join() !== expected.join()) bad.push(`Tab order differs from labels.ts: got ${walked.join(' > ')}`)
    if (walked.length < 6) bad.push(`Tab walk reached only ${walked.length} Shipping Requirements controls`)

    // one image per section, the section scrolled to the top of the form, light theme
    for (const [n, [key]] of SECTIONS.entries()) {
      await b.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(tid(`section-${key}`))}); const t = document.querySelector(${JSON.stringify(tid(`section-${key}-toggle`))}); if (t && t.getAttribute('aria-expanded') === 'false') t.click(); s.scrollIntoView({ block: 'start' }) })()`)
      await pause(250)
      await shotFile(b, `04-${String(n + 1).padStart(2, '0')}-section-${key}`)
    }
    await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
    await shotFile(b, '04-00-form-top')
    for (const width of [1600, 1280]) {
      await b.setViewport(width, 1400)
      await pause(400)
      const overflow = await b.evaluate(`Math.max(document.documentElement.scrollWidth - innerWidth, (document.querySelector('.tms-ship-form-scroll')?.scrollWidth ?? 0) - (document.querySelector('.tms-ship-form-scroll')?.clientWidth ?? 0))`)
      if (overflow > 1) bad.push(`horizontal scroll of ${overflow}px at ${width}px`)
    }
    await b.setViewport(1600, 1400)
    failures([...bad, ...problemList(b).slice(0, 2)])
    return `12 sections with their Aljex headings, ${reds.length} red-required controls, ${order.length} Shipping Requirements controls + ${facts.flags.length} flags, Tab order pinned, no horizontal scroll at 1600 / 1280; 12 section screenshots`
  },

  async AH05(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    const bad = []
    for (const [key] of SECTIONS) {
      const read = () => b.evaluate(`document.querySelector(${JSON.stringify(tid(`section-${key}-toggle`))}).getAttribute('aria-expanded')`)
      const before = await read()
      await click(b, `section-${key}-toggle`); await pause(120)
      const closed = await read()
      await click(b, `section-${key}-toggle`); await pause(120)
      const after = await read()
      if (before !== 'true' || closed !== 'false' || after !== 'true') bad.push(`${key}: ${before} → ${closed} → ${after}`)
    }
    // collapsed state persists across a reload; the harness only needs one section to prove it
    await click(b, 'section-history-toggle'); await pause(200)
    await b.reload(); await b.poll(() => has(b, tid('ship-form')), 'form after reload', 60_000); await pause(600)
    const persisted = await b.evaluate(`document.querySelector(${JSON.stringify(tid('section-history-toggle'))}).getAttribute('aria-expanded')`)
    if (persisted !== 'false') bad.push(`Historical Rates reopened after a reload (${persisted})`)
    await click(b, 'section-history-toggle')
    failures(bad)
    return 'every section collapses and expands (aria-expanded flips); a collapsed section stays collapsed after a reload'
  },

  async AH06(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    const url = await pathOf(b)
    await click(b, 'ship-form-create')
    await b.poll(() => has(b, tid('ship-form-issues')), 'issues strip', 15_000)
    const text = await b.evaluate(`document.querySelector(${JSON.stringify(tid('ship-form-issues'))}).innerText`)
    const bad = []
    for (const name of ['Equipment', 'Revenue Type', 'Weight', 'Description']) if (!text.includes(name)) bad.push(`issues strip does not name ${name}`)
    if ((await pathOf(b)) !== url) bad.push('Create on an empty form navigated away')
    await shotFile(b, '06-issues-strip')
    await click(b, 'ship-form-save-draft')
    await b.poll(async () => /local draft/i.test(await bodyText(b)), 'local-draft notice', 6_000).catch(() => {})
    if (shipmentIdFromPath(await pathOf(b))) bad.push('Save draft with no customer created a server shipment')
    if (!/local draft/i.test(await bodyText(b))) bad.push('Save draft with no customer did not say it was kept as a local draft')
    failures(bad)
    return 'Create on the empty form lists the required fields and stays put; Save draft without a customer stays local'
  },

  async AH07(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    await fill(b, 'f-shipping-description', 'ZZ AH local draft probe')
    await pause(1600) // the autosave is debounced
    await b.reload(); await b.poll(() => has(b, tid('ship-form-drafts')), 'resume banner', 60_000)
    await shotFile(b, '07-resume-draft-banner')
    await b.click({ selector: '[data-testid^="ship-form-draft-resume-"]' }); await pause(500)
    const restored = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-description'))}).value`)
    expect(restored === 'ZZ AH local draft probe', `Resume did not restore the Description (got ${JSON.stringify(restored)})`)
    await b.reload(); await b.poll(() => has(b, tid('ship-form-drafts')), 'resume banner (2)', 60_000)
    await b.click({ selector: '[data-testid^="ship-form-draft-discard-"]' }); await pause(400)
    expect(!(await has(b, tid('ship-form-drafts'))), 'Discard left the banner on screen')
    return 'a typed Description survives a reload as a local draft, Resume restores it, Discard clears it'
  },

  async AH08(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await click(b, 'ship-form-save-draft')
    const id = await waitEditUrl(ctx, b, 'draft with only a customer')
    const bundle = await getBundle(ctx, id)
    expect(bundle.shipment.status === 'DRAFT', `status ${bundle.shipment.status}, wanted DRAFT`)
    expect(bundle.shipment.customerId === ctx.customerId, 'the draft is not on the ZZ customer')
    ctx.draftId = id
    return `a customer alone is enough for a server draft (${id}), landed on the edit URL`
  },

  async AH09(ctx) {
    const b = ctx.b
    const facts = await labelFacts()
    await openForm(b, '/tms/shipments/new')
    // Customer
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await fill(b, 'f-customer-hours', '08:00-16:00')
    for (let n = 1; n <= 6; n += 1) await fill(b, `f-customer-email-${n}`, `zz-ah-${n}-${ctx.ts}@example.invalid`)
    await fill(b, 'f-customer-refNo', ctx.refPo)
    // Shipping Requirements
    await fill(b, 'f-shipping-equipmentType', 'Dry Van')
    ctx.revDivision = await selectFirst(b, 'f-shipping-revDivision')
    await fill(b, 'f-shipping-customerMiles', '500')
    await fill(b, 'f-shipping-truckMiles', '520')
    await fill(b, 'f-shipping-footage', '48')
    await fill(b, 'f-shipping-pieces', '10')
    await fill(b, 'f-shipping-weightLbs', '12000')
    await fill(b, 'f-shipping-billableWeightLbs', '12500')
    await fill(b, 'f-shipping-description', ctx.commodity)
    await fill(b, 'f-shipping-declaredValue', '5000')
    await fill(b, 'f-shipping-liftgate', 'no')
    await fill(b, 'f-shipping-inside', 'yes')
    ctx.flagsTicked = []
    for (const k of facts.flags) if (await check(b, `f-shipping-flag-${k}`)) ctx.flagsTicked.push(k)
    await check(b, 'f-shipping-tempControl')
    await fill(b, 'f-shipping-tempType', 'C'); await fill(b, 'f-shipping-tempMin', '2'); await fill(b, 'f-shipping-tempMax', '4'); await fill(b, 'f-shipping-tempPreCool', '1')
    await check(b, 'f-shipping-palletExchange')
    await fill(b, 'f-shipping-palletsIn', '3'); await fill(b, 'f-shipping-palletsOut', '2')
    await check(b, 'f-shipping-tarps'); await fill(b, 'f-shipping-tarpSize', '6 ft')
    // Pick Up and Consignee: the ZZ locations are picked from the directory, never typed in as new ones
    await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
    await fill(b, 'f-pickup-contact', 'ZZ AH Dock'); await fill(b, 'f-pickup-phone', '5550100'); await fill(b, 'f-pickup-hours', '06:00-14:00')
    await fill(b, 'f-pickup-refNo', ctx.refPickup)
    await fill(b, 'f-pickup-ready', localDt(1, 7)); await fill(b, 'f-pickup-appt', localDt(1, 8))
    await pickFrom(b, tid('f-consignee-name'), tid('f-consignee-name-option'), ctx.locNames.receiver)
    await fill(b, 'f-consignee-contact', 'ZZ AH Receiving'); await fill(b, 'f-consignee-hours', '07:00-15:00')
    await fill(b, 'f-consignee-refNo', ctx.refDelivery)
    await fill(b, 'f-consignee-appt', localDt(3, 10)); await fill(b, 'f-consignee-mustDeliver', localDt(3, 18))
    // Picks & Stops: one extra pick and one extra stop between the two
    await click(b, 'f-picks-insertPick')
    await b.poll(() => has(b, tid('f-stop-1-name')), 'inserted pick fields', 10_000)
    await pickFrom(b, tid('f-stop-1-name'), tid('f-stop-1-name-option'), ctx.locNames.pick2)
    await fill(b, 'f-stop-1-appt', localDt(1, 12))
    await click(b, 'f-picks-insertStop')
    await b.poll(() => has(b, tid('f-stop-2-name')), 'inserted stop fields', 10_000)
    await pickFrom(b, tid('f-stop-2-name'), tid('f-stop-2-name-option'), ctx.locNames.stop2)
    await fill(b, 'f-stop-2-appt', localDt(2, 12))
    // Roles, More Information
    // Sales Representative is a RepPicker (not a <select>); the ZZ customer's default rep prefills it.
    await fill(b, 'f-more-specialInstructions', 'S'.repeat(420))
    await b.click({ selector: `${tid('section-more-body')} [role="tab"]`, pattern: '^Rate Confirmation Notes' }); await pause(200)
    await fill(b, 'f-more-rateConNotes', 'R'.repeat(260))
    // Rates: per-hour customer line haul + FSC % + one accessorial
    await fill(b, 'f-rates-customerRateType', 'PER_HOUR')
    await fill(b, 'f-rates-customerHours', '2'); await fill(b, 'f-rates-customerLhRate', '600'); await fill(b, 'f-rates-fscPercent', '10')
    await click(b, 'f-rates-addLine')
    await b.poll(() => has(b, tid('rates-line-0')), 'accessorial line', 10_000)
    await fillAria(b, 'Release 1', 'R1'); await fillAria(b, 'Accessorial 1', 'LUMPER'); await fillAria(b, '$Customer 1', '75')
    await shotFile(b, '09-filled-form')
    await click(b, 'ship-form-create')
    const id = await waitEditUrl(ctx, b, 'create')
    ctx.fullId = id
    await shotFile(b, '09-after-create-edit-mode')
    const bundle = await getBundle(ctx, id)
    expect(bundle.shipment.status === 'DRAFT', `created as ${bundle.shipment.status}, wanted DRAFT`)
    const mine = (await listAll(ctx.token, 'Shipment', { customerId: { eq: ctx.customerId } }, 'id')).length
    expect(mine === 2, `${mine} shipments on the ZZ customer after one draft + one Create (wanted exactly 2: Create must not double-fire)`)
    return `Create landed on /tms/shipments/${id}/edit as a DRAFT; ${ctx.flagsTicked.length} flags ticked; exactly one new shipment`
  },

  async AH10(ctx) {
    expect(ctx.fullId, 'AH09 did not create a shipment')
    const bundle = await getBundle(ctx, ctx.fullId)
    const order = bundle.orders[0]
    const load = bundle.loads[0]
    const sr = order.specialRequirements ?? {}
    const form = sr.form ?? {}
    const bad = []
    const eq = (label, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${label}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`) }
    eq('order.equipmentType', order.equipmentType, 'Dry Van')
    const FLAG_KEYS = { permits: 'permit', fsma: 'fsma', oversized: 'oversize', hazmat: 'hazmat', escorts: 'escort', seal: 'sealRequired', blind: 'blind', strapsChains: 'straps', noBroker: 'noBroker', team: 'team', labor: 'labor', highRisk: 'highRisk', massRelease: 'massRelease' }
    for (const k of ctx.flagsTicked) {
      if (FLAG_KEYS[k] && sr[FLAG_KEYS[k]] !== true) bad.push(`specialRequirements.${FLAG_KEYS[k]} is ${JSON.stringify(sr[FLAG_KEYS[k]])}, wanted true`)
    }
    if (ctx.flagsTicked.includes('customsBonded') && !sr.customsBond) bad.push('specialRequirements.customsBond is empty')
    if (ctx.flagsTicked.includes('osd')) eq('shipment.osd', bundle.shipment.osd, true)
    if (ctx.flagsTicked.includes('hot')) eq('load.hot', load.hot, true)
    eq('liftgate', sr.liftgate, false); eq('inside', sr.inside, true)
    eq('tempControl', sr.tempControl, true); eq('tarps', sr.tarps, true); eq('palletExchange', sr.palletExchange, true)
    eq('tempF mirror (2-4 °C → °F)', [sr.tempF?.min, sr.tempF?.max], [36, 39])
    eq('form.ship.temp', [form.ship?.temp?.unit, form.ship?.temp?.min, form.ship?.temp?.max], ['C', 2, 4])
    eq('form.ship.truckMiles', form.ship?.truckMiles, 520)
    eq('form.customer.emails', form.customer?.emails?.length, 6)
    eq('form.customer.hours', form.customer?.hours, '08:00-16:00')
    eq('form.instructions.special length', form.instructions?.special?.length, 420)
    eq('form.instructions.rateCon length', form.instructions?.rateCon?.length, 260)
    const refs = Object.fromEntries((order.references ?? []).map((r) => [r.code, r.value]))
    eq('references PO', refs.PO, ctx.refPo); eq('references pickup', refs.pickup, ctx.refPickup); eq('references delivery', refs.delivery, ctx.refDelivery)
    eq('freight[0].id', order.freight?.[0]?.id, 'frt-main')
    eq('load commodity / weight / pieces', [load.commodity, load.weight, load.pieces], [ctx.commodity, 12000, 10])
    eq('load cargoValueCents / miles', [load.cargoValueCents, load.miles], [500000, 500])
    const stops = [...(load.stops ?? [])].sort((a, c) => a.sequence - c.sequence)
    eq('stop count and types', stops.map((s) => s.type), ['pickup', 'pickup', 'delivery', 'delivery'])
    if (!stops[0]?.requestedStart) bad.push('first pickup has no requestedStart (Ready)')
    if (!stops[3]?.requestedEnd) bad.push('consignee has no requestedEnd (Must Deliver)')
    eq('pickup contact.hours', stops[0]?.contact?.hours, '06:00-14:00')
    if (!bundle.shipment.revDivision) bad.push('no revenue division on the shipment')
    if (!bundle.shipment.salesRepId) bad.push('no sales representative on the shipment')
    const own = bundle.charges.filter((c) => c.side === 'CUSTOMER')
    const lh = own.find((c) => c.code === 'LINEHAUL')
    eq('LINEHAUL calculatedBy / count / rateCents', [lh?.calculatedBy, lh?.count, lh?.rateCents], ['FLAT', 2, 60000])
    const fsc = own.find((c) => c.code === 'FSC')
    eq('FSC calculatedBy / rate (bps)', [fsc?.calculatedBy, fsc?.rateCents], ['PERCENT', 1000])
    const acc = own.find((c) => c.code === 'LUMPER')
    eq('accessorial LUMPER release / rateCents', [acc?.release, acc?.rateCents], ['R1', 7500])
    if (bundle.charges.some((c) => c.side === 'CARRIER')) bad.push('a CARRIER charge exists before Cover')
    failures(bad)
    return `${stops.length} stops, ${own.length} customer charge lines, references PO / pickup / delivery, ${ctx.flagsTicked.length} flags, extras and tempF mirror all saved as typed`
  },

  async AH11(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    const bad = []
    const val = (id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.value ?? null`)
    const eq = (id, want) => val(id).then((got) => { if (got !== want) bad.push(`${id}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`) })
    await eq('f-shipping-description', ctx.commodity)
    await eq('f-shipping-weightLbs', '12000')
    await eq('f-shipping-pieces', '10')
    await eq('f-shipping-customerMiles', '500')
    await eq('f-shipping-truckMiles', '520')
    await eq('f-shipping-tempMin', '2')
    await eq('f-shipping-tempMax', '4')
    await eq('f-shipping-palletsIn', '3')
    await eq('f-customer-refNo', ctx.refPo)
    await eq('f-customer-hours', '08:00-16:00')
    await eq('f-rates-customerHours', '2')
    await eq('f-rates-fscPercent', '10')
    await eq('f-pickup-refNo', ctx.refPickup)
    await eq('f-consignee-refNo', ctx.refDelivery)
    for (const k of ctx.flagsTicked) {
      const on = await b.evaluate(`document.querySelector(${JSON.stringify(tid(`f-shipping-flag-${k}`))})?.checked ?? null`)
      if (on !== true) bad.push(`flag ${k} reloads unticked`)
    }
    await shotFile(b, '11-edit-mode-reloaded')
    failures(bad)
    return 'the edit URL reloads every control with what was saved (value by value)'
  },

  async AH12(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    await click(b, 'ship-form-submit')
    await b.poll(async () => {
      const status = (await getBundle(ctx, ctx.fullId)).shipment.status
      return status !== 'DRAFT' || await has(b, tid('ship-form-issues')) || await has(b, tid('ship-form-partial'))
    }, 'Submit order result', 60_000).catch(() => {})
    const after = await getBundle(ctx, ctx.fullId)
    if (after.shipment.status !== 'DRAFT') {
      ctx.submitted = true
      return `Submit order moved the shipment DRAFT → ${after.shipment.status}`
    }
    const text = (await b.evaluate(`document.querySelector(${JSON.stringify(tid('ship-form-issues'))})?.innerText ?? ''`)) || (await bodyText(b)).slice(0, 300)
    throw new Error(`Submit order left the shipment a DRAFT: ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 300))}`)
  },

  async AH13(ctx) {
    expect(ctx.submitted, 'AH12 did not submit the order')
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    const bad = []
    const modeDisabled = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-mode'))})?.disabled ?? null`)
    if (modeDisabled !== true) bad.push(`Mode is ${modeDisabled === null ? 'missing' : 'still editable'} on a submitted order`)
    await shotFile(b, '13-edit-live-locked-fields')
    await fill(b, 'f-shipping-description', `${ctx.commodity} edited`)
    await fill(b, 'f-shipping-customerMiles', '650')
    await click(b, 'ship-form-save')
    await b.poll(async () => (await getBundle(ctx, ctx.fullId)).loads[0]?.commodity?.endsWith('edited') === true || await has(b, tid('ship-form-issues')), 'edit saved', 45_000)
    const after = await getBundle(ctx, ctx.fullId)
    if (after.loads[0]?.commodity !== `${ctx.commodity} edited`) bad.push(`commodity is ${JSON.stringify(after.loads[0]?.commodity)} after Save changes`)
    if (after.loads[0]?.miles !== 650) bad.push(`miles is ${after.loads[0]?.miles} after Save changes (wanted 650)`)
    const audit = await listAll(ctx.token, 'AuditLog', { entityId: { eq: ctx.fullId }, action: { eq: 'UPDATE_ORDER_DETAILS' } }, 'id')
    if (audit.length === 0) bad.push('no UPDATE_ORDER_DETAILS audit row after editing a non-draft shipment')
    failures(bad)
    return `Save changes on an OPEN order wrote through UPDATE_ORDER_DETAILS (${audit.length} audit rows); Mode is locked`
  },

  async AH14(ctx) {
    expect(ctx.submitted, 'AH12 did not submit the order')
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    await setValue(b, '#carrier-search', ctx.carrierName)
    await b.poll(() => has(b, `${tid('carrier-matches')} button`), 'carrier matches', 20_000)
    await clickSel(b, `${tid('carrier-matches')} button`); await pause(300)
    await fill(b, 'f-carrier-originCity', 'Joliet'); await fill(b, 'f-carrier-originState', 'IL')
    await fill(b, 'f-rates-carrierLhRate', '500')
    await pause(300)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('section-carrier'))}).scrollIntoView({ block: 'start' })`)
    await shotFile(b, '14-carrier-before-cover')
    await click(b, 'f-carrier-cover')
    const opened = await b.poll(() => has(b, '[role="dialog"]'), 'Cover dialog', 20_000).then(() => true, () => false)
    if (!opened) {
      const reason = await b.evaluate(`document.querySelector(${JSON.stringify(tid('carrier-cover-reason'))})?.innerText ?? document.querySelector(${JSON.stringify(tid('carrier-cover-hint'))})?.innerText ?? ''`)
      throw new Error(`Cover did not open the booking dialog (${JSON.stringify(reason)})`)
    }
    await shotFile(b, '14-cover-dialog')
    const text = await b.evaluate(`[...document.querySelectorAll('[role="dialog"]')].pop().innerText`)
    expect(/book|cover|carrier/i.test(text), 'the dialog that opened is not the carrier booking dialog')
    await b.press('Escape'); await pause(300)
    return 'Cover opens the booking dialog with the carrier picked in the form (not confirmed: booking a carrier is out of scope here)'
  },
}

// ───────────────────────────── helpers that talk to dev ─────────────────────────────
async function listAll(token, model, filter, selection) {
  const rows = []
  let next = null
  do {
    const r = await gql(token, `query($f: Model${model}FilterInput, $n: String) { list${model}s(filter: $f, limit: 1000, nextToken: $n) { items { ${selection} } nextToken } }`, { f: filter, n: next })
    rows.push(...r[`list${model}s`].items)
    next = r[`list${model}s`].nextToken
  } while (next)
  return rows
}
const getRow = async (token, model, id, selection) => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]

async function setupFixtures(ctx) {
  const { ts } = ctx
  const profiles = (await gql(ctx.token, 'query { listUserProfiles(limit: 1000) { items { id status } } }', {})).listUserProfiles.items
  const repId = (profiles.find((p) => p.status === 'ACTIVE') ?? profiles[0])?.id ?? null
  if (!repId) throw new Error('no UserProfile exists in dev to act as the sales rep')
  ctx.customerName = `ZZ AH Customer ${ts}`
  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: ctx.customerName, creditLimitCents: 100_000_000, defaultSalesRepId: repId,
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AH Contact', email: `zz-ah-contact-${ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `zz-ah-bt-${ts}`, name: 'ZZ AH Bill To', isDefault: true }],
  })
  ctx.customerId = String((customer.customer ?? customer).id)
  ctx.locNames = { shipper: `ZZ AH Shipper ${ts}`, receiver: `ZZ AH Receiver ${ts}`, pick2: `ZZ AH Second Pick ${ts}`, stop2: `ZZ AH Second Stop ${ts}` }
  const places = [['shipper', 'Chicago', 'IL', '60601'], ['receiver', 'Dallas', 'TX', '75201'], ['pick2', 'Joliet', 'IL', '60431'], ['stop2', 'Waco', 'TX', '76701']]
  for (const [key, city, state, zip] of places) {
    const loc = await ctx.dir('UPSERT_LOCATION', { name: ctx.locNames[key], street: '1 ZZ Test Way', city, state, zip, country: 'US' })
    ctx.locationIds.push(String((loc.location ?? loc).id))
  }
  ctx.carrierName = `ZZ AH Carrier ${String(ts).slice(-6)}`
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const n = String(ts).slice(-6)
  const carrier = await ctx.car('UPSERT_CARRIER', {
    name: ctx.carrierName, type: 'TL', status: 'ACTIVE', mcNumber: `9${n}`, dotNumber: `9${n}`, mcpStatus: 'NOT_INVITED',
    accountingEmail: `zz-ah-carrier-ap-${ts}@example.invalid`, dispatcherEmail: `zz-ah-dispatch-${ts}@example.invalid`,
    insurancePolicies: [
      { type: 'AUTO_LIABILITY', company: 'ZZ AH Mutual', policyNumber: `ZZAL-${ts}`, limitCents: 100000000, expiresAt: nextYear },
      { type: 'CARGO', company: 'ZZ AH Mutual', policyNumber: `ZZCG-${ts}`, limitCents: 10000000, expiresAt: nextYear },
    ],
    notes: 'ZZ AH harness carrier. Not a real carrier; safe to archive.',
  }).then((r) => r.carrier ?? r)
  ctx.carrierId = String(carrier.id)
  ctx.commodity = `ZZ AH freight ${ts}`
  ctx.refPo = `ZZ-AH-PO-${ts}`; ctx.refPickup = `ZZ-AH-PU-${ts}`; ctx.refDelivery = `ZZ-AH-DL-${ts}`
}

async function cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1 }
  if (!ctx.token) return
  const ids = new Set(ctx.shipmentIds)
  if (ctx.customerId) {
    for (const r of await listAll(ctx.token, 'Shipment', { customerId: { eq: ctx.customerId } }, 'id').catch(() => [])) ids.add(r.id)
  }
  for (const id of ids) {
    try {
      const row = await getRow(ctx.token, 'Shipment', id, 'id updatedAt voidedAt')
      if (!row?.voidedAt) await ctx.shipAs.admin('VOID_SHIPMENT', { shipmentId: id, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = await getRow(ctx.token, 'Shipment', id, 'voidedAt')
      say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
    } catch (err) { say(`shipment ${id} void failed: ${short(err).slice(0, 100)}`, false) }
  }
  if (ctx.carrierId) {
    const row = await getRow(ctx.token, 'Carrier', ctx.carrierId, 'id updatedAt status').catch(() => null)
    if (row) await ctx.car('SET_CARRIER_STATUS', { id: ctx.carrierId, expectedUpdatedAt: String(row.updatedAt), status: 'INACTIVE', reason: 'INACTIVE_AGREEMENT' }).then(() => say(`carrier ${ctx.carrierId} set INACTIVE`), (err) => say(`carrier retire failed: ${short(err).slice(0, 80)}`, false))
  }
  for (const id of ctx.locationIds) {
    const row = await getRow(ctx.token, 'Location', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_LOCATION', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`location ${id} archived`), (err) => say(`location archive failed: ${short(err).slice(0, 80)}`, false))
  }
  if (ctx.customerId) {
    const row = await getRow(ctx.token, 'Customer', ctx.customerId, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${ctx.customerId} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

async function runStep(ctx, step) {
  if (!matches(step.id)) return
  const b = ctx.b
  b?.mark()
  try {
    const detail = await RUNNERS[step.id](ctx)
    line('PASS', `${step.id} ${step.slug}`, typeof detail === 'string' ? detail : undefined)
  } catch (err) {
    line('FAIL', `${step.id} ${step.slug}`, short(err).slice(0, 600))
    await b?.screenshot(join(SHOTS, `${step.id}-failure-L.png`)).then(() => written.push(join(SHOTS, `${step.id}-failure-L.png`))).catch(() => {})
  }
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAH refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAH refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAH only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = { admin: `zz-ah-admin-${ts}@example.invalid`, tms: `zz-ah-tms-${ts}@example.invalid` }
  const made = []
  const ctx = { ts, origin, ids: {}, shipmentIds: new Set(), locationIds: [], flagsTicked: [], submitted: false }
  try {
    ctx.ids.admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    ctx.ids.tms = await mintIdentity(emails.tms, ['page-tms']); made.push(emails.tms)
    console.log('identity: temporary staff identities created (admin, page-tms only)')
    ctx.token = ctx.ids.admin.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.car = routerAs(ctx.token, 'tmsCarrierActions')
    ctx.shipAs = { admin: routerAs(ctx.token, 'tmsShipmentActions') }
    await setupFixtures(ctx)
    console.log(`fixtures: customer ${ctx.customerId}, carrier ${ctx.carrierId}, ${ctx.locationIds.length} locations`)

    for (const step of AH_STEPS.filter((s) => ['AH01', 'AH02'].includes(s.id))) await runStep(ctx, step)
    ctx.b = await launchBrowser({ origin, storage: ctx.ids.admin.storage, profilePrefix: 'bcat-ah-', purpose: 'AH verification', viewport: { width: 1600, height: 1400, deviceScaleFactor: 1 } })
    try {
      await ctx.b.navigate('/tms/dashboard'); await waitLoaded(ctx.b).catch(() => {})
      await walk.setTheme(ctx.b, 'light').catch(() => {})
      for (const step of AH_STEPS.filter((s) => !['AH01', 'AH02'].includes(s.id))) await runStep(ctx, step)
    } finally { await ctx.b.close() }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${short(err).slice(0, 120)})`); process.exitCode = 1 })
    for (const email of made.slice().reverse()) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAH failed: ${err?.message ?? err}`); process.exit(1) })
}
