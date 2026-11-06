#!/usr/bin/env node
/**
 * Step AH + Step AR verification against the DEV site (or `npm run dev` on localhost): the Create-shipment button bug,
 * the Aljex-parity create / edit form (AH-plan §2, §12) on the Step AR layout (header, five cards, More tabs, summary
 * rail) and the AR01-AR09 layout / keyboard / rail checks. `--only=AR` runs just the AR steps.
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
import { tmpdir } from 'node:os'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { AA_HOMES } from './lib/aaRoutes.mjs'
import { requiredPatterns, missingFromRoutes } from './devVerifyS2.mjs'
import { discoverDevSuffix, devTable, doc } from './devVerifyU.mjs'
import { PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const SHOTS = resolve('Docs/tms-build/screenshots/ah')
const SHOTS2 = resolve('Docs/tms-build/screenshots/ah2') // Ryne's feedback round, 1440 px
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
  ['freight', 'Freight'], ['route', 'Route'], ['rates', 'Rates'],
  ['carrier', 'Carrier & Tracking'], ['documents', 'Documents'],
]
const MORE_TABS = ['instructions', 'references', 'items', 'notes']
const AR_DIR = resolve('Docs/tms-build/aljex-create')

/** Every AH id, in run order. All need the browser; AH08-AH14 also write to dev. */
export const AH_STEPS = [
  { id: 'AH01', slug: 'board-create-button' },
  { id: 'AH02', slug: 'tracking-create-button' },
  { id: 'AH03', slug: 'mint-card' },
  { id: 'AH04', slug: 'cards-render' },
  { id: 'AH05', slug: 'more-tabs' },
  { id: 'AH06', slug: 'validation' },
  { id: 'AH07', slug: 'local-draft' },
  { id: 'AH08', slug: 'draft-customer-only' },
  { id: 'AH09', slug: 'create-full' },
  { id: 'AH10', slug: 'saved-fields' },
  { id: 'AH11', slug: 'edit-roundtrip' },
  { id: 'AH12', slug: 'submit-order' },
  { id: 'AH13', slug: 'edit-live' },
  { id: 'AH14', slug: 'cover-entry' },
  { id: 'AH15', slug: 'feedback-required-style' },
  { id: 'AH16', slug: 'feedback-customer-emails-bill-to' },
  { id: 'AH17', slug: 'feedback-auto-miles' },
  { id: 'AH18', slug: 'feedback-check-calls-preview' },
  { id: 'AH19', slug: 'feedback-sections-1440' },
  { id: 'AH20', slug: 'feedback-intake-prefill' },
  { id: 'AH21', slug: 'feedback-intake-create-links' },
  { id: 'AR01', slug: 'keyboard-and-esc' },
  { id: 'AR02', slug: 'rail-required-and-sticky' },
  { id: 'AR03', slug: 'rail-bottom-sheet' },
  { id: 'AR04', slug: 'route-timeline' },
  { id: 'AR05', slug: 'requirement-chips' },
  { id: 'AR06', slug: 'ivan-cartage-create' },
  { id: 'AR07', slug: 'layout-fit-1280-1440' },
  { id: 'AR08', slug: 'intake-board-create' },
  { id: 'AR09', slug: 'walkthrough-shots' },
  { id: 'AR10', slug: 'documents-on-create' },
  { id: 'AR11', slug: 'bill-to-and-rate-history-cards' },
  { id: 'AR12', slug: 'rail-activity-roles-shipment-type' },
  { id: 'AR13', slug: 'carrier-and-tracking-mode' },
  { id: 'AR14', slug: 'grid-symmetry-and-timeline' },
  { id: 'AR15', slug: 'multi-stop-miles' },
  { id: 'AR16', slug: 'inline-new-location' },
  { id: 'AR17', slug: 'inline-new-customer' },
  { id: 'AR18', slug: 'action-bar' },
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
  for (let n = 1; n <= 2; n += 1) ids.add(`f-customer-email-${n}`)
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
    ...await sourceFiles('src/features/shipments/trackingModeControl'),
    'src/features/shipments/ShipmentsBoard.tsx',
    'src/features/shipments/DeliveryTimeline.tsx',
    'src/features/shipments/intake/IntakeBoard.tsx',
    'src/features/shipments/components/ShipmentDetail.tsx',
    'src/features/tms/brokerage/company/components/MintShipmentCard.tsx',
  ]
  const haystack = (await Promise.all(sources.map((f) => readFile(resolve(f), 'utf8')))).join('\n')
  const ids = new Set([...self.matchAll(/\btid\('([^'$]+)'\)/g)].map((m) => m[1]))
  const derived = new Set([...facts.ids, ...facts.flags.map((k) => `f-shipping-flag-${k}`)])
  const absent = [...ids].filter((id) => !derived.has(id) && !haystack.includes(`"${id}"`) && !haystack.includes(`'${id}'`) && !haystack.includes(`\`${id}\``))
  // `section-<key>[-toggle]`, `rates-line-<i>` and `f-<prefix>-<field>` are built from a variable in the source: check the stem.
  const stems = [
    [/^section-[A-Za-z]+$/, 'section-${id}'], [/^f-route-handle-\d+$/, 'f-route-handle-${'], [/^f-route-remove-\d+$/, 'f-route-remove-${'], [/^f-customer-name-input$/, '-input`'], [/^f-route-add(Pickup|Delivery)-\d+$/, 'f-route-add'], [/^more-tab-/, 'more-tab-${'], [/^more-panel-/, 'more-panel-${'],
    [/^rates-line-\d+$/, 'rates-line-${i}'], [/^f-(pickup|consignee|stop-\d)-/, '`f-${prefix}-'],
  ]
  const unresolved = absent.filter((id) => !stems.some(([re, stem]) => re.test(id) && haystack.includes(stem)))
  if (unresolved.length) { line('FAIL', 'gate 3: every data-testid a step selects exists', unresolved.join(', ')); return false }
  const labelMiss = SECTIONS.map(([k]) => `section-${k}`).filter((id) => !haystack.includes('section-${id}') && !haystack.includes(id))
  if (labelMiss.length) { line('FAIL', 'gate 3: card sections', labelMiss.join(', ')); return false }
  line('PASS', 'gate 3: every data-testid a step selects exists', `${ids.size} literal ids, ${facts.ids.size} label-derived ids, ${facts.flags.length} flags, ${SECTIONS.length} cards`)

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
/** The Route card's one Miles field is read-only: the pencil popover is how a person types a number. */
async function overrideMiles(b, value) {
  await click(b, 'f-shipping-milesEdit'); await pause(150)
  await fill(b, 'f-shipping-milesInput', value)
  await click(b, 'f-shipping-milesApply'); await pause(150)
}
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
  await b.poll(() => has(b, optionSelector), `suggestion for ${optionSelector}`, 40_000)
  // Prefer the suggestion that carries the typed name (a recent but different place may be listed first).
  const hit = await b.evaluate(`(() => { const o = [...document.querySelectorAll(${JSON.stringify(optionSelector)})]; const el = o.find((n) => n.textContent.includes(${JSON.stringify(text)})) ?? o[0]; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`)
  if (!hit) throw new Error(`click ${optionSelector}: no-element`)
  await pause(300)
}
// Not the "+ Add as a new customer" row, which also shows while the directory is still loading.
const CUSTOMER_OPTION = `${tid('f-customer-name')} li button:not([data-testid="f-customer-addRow"])`

const localDay = (offset) => localDt(offset, 0).slice(0, 10)
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

async function shotFile2(b, name) {
  const file = join(SHOTS2, `${name}-L.png`)
  await b.screenshot(file)
  written.push(file)
}

/** Step AR walkthrough image: Docs/tms-build/aljex-create/ar-<name>.png (light theme, no PII: ZZ fixtures only). */
async function shotAR(b, name) {
  await mkdir(AR_DIR, { recursive: true })
  const file = join(AR_DIR, `ar-${name}.png`)
  await b.screenshot(file)
  written.push(file)
}

/** A real key chord through CDP (modifiers: 2 = Ctrl, 4 = Meta). */
async function chord(b, key, modifiers) {
  const vk = key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0)
  const base = { key, code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await b.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await b.command('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const textOf = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.innerText ?? null`)
const valOf = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.value ?? null`)
const activeId = (b) => b.evaluate(`document.activeElement?.getAttribute('data-testid') ?? ''`)
const rectOf = (b, selector) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } })()`)
const countOf = (b, selector) => b.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const overflowOf = (b) => b.evaluate(`Math.max(document.documentElement.scrollWidth - innerWidth, (document.querySelector('.tms-ship-form-scroll')?.scrollWidth ?? 0) - (document.querySelector('.tms-ship-form-scroll')?.clientWidth ?? 0))`)

/** The seven Aljex reds, minimal: customer, equipment, Division, weight, description, pickup name + ready. */
async function fillRequired(ctx, b, { division } = {}) {
  await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
  await fill(b, 'f-shipping-equipmentType', 'Dry Van')
  if (division) await fill(b, 'f-shipping-revDivision', division); else await selectFirst(b, 'f-shipping-revDivision')
  await fill(b, 'f-shipping-weightLbs', '12000')
  await fill(b, 'f-shipping-description', ctx.commodity)
  // Re-typing the name an earlier step already picked is no change: the suggestion list would never open.
  if ((await valOf(b, 'f-pickup-name')) !== ctx.locNames.shipper) await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
  await fill(b, 'f-pickup-ready', localDt(1, 7))
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
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    // header strip: title, Customer type-ahead, Bill To chip, status chip, read-only PRO preview (no Division or Mode pill)
    const title = await textOf(b, 'ship-form-title')
    if (title !== 'New shipment') bad.push(`title is ${JSON.stringify(title)}`)
    for (const id of ['ship-form-header', 'f-customer-name', 'hdr-billTo-chip', 'ship-form-status', 'ship-form-pro']) if (!(await has(b, tid(id)))) bad.push(`header lacks ${id}`)
    if (await has(b, `${tid('ship-form-header')} ${tid('f-shipping-shipmentType')}`) || await has(b, '[data-testid="f-header-' + 'division"]')) bad.push('the Mode / Shipment type / Division select is still in the header')
    if ((await b.evaluate(`document.querySelectorAll('[data-testid="f-shipping-revDivision"]').length`)) !== 1) bad.push('Division / Revenue Type renders more than once')
    if ((await b.evaluate(`document.querySelector('[data-testid="ship-form-header-panel"]')?.hidden ?? null`)) !== true) bad.push('the Bill To panel is not collapsed by default')
    if ((await b.evaluate(`(document.querySelector('[data-testid="section-freight-body"] select, [data-testid="section-freight-body"] input'))?.dataset.testid ?? null`)) !== 'f-shipping-revDivision') bad.push('Division is not the first field of the Freight card')
    if ((await valOf(b, 'f-shipping-shipmentType')) !== 'FTL') bad.push('Shipment type does not default to FTL')
    if ((await textOf(b, 'ship-form-status')) !== 'Draft') bad.push('status chip is not Draft')
    if (await has(b, `${tid('ship-form-pro')} input`)) bad.push('the PRO preview is editable')
    // five numbered cards in build order
    const heads = await b.evaluate(`[...document.querySelectorAll('.tms-ship-card')].map((c) => c.dataset.testid + ':' + c.querySelector('.tms-ship-card-num')?.textContent + ':' + c.querySelector('.tms-ship-card-title')?.textContent)`)
    const want = SECTIONS.map(([k, t], i) => `section-${k}:${i + 1}:${t}`)
    if (heads.join('|') !== want.join('|')) bad.push(`cards ${heads.join(' | ')} ≠ ${want.join(' | ')}`)
    const reds = ['Equipment (required)', 'Division (required)', 'Weight (required)', 'Description (required)', 'Customer (required)', 'Name (required)', 'Ready (required)']
    for (const label of reds) if (!(await has(b, `[aria-label=${JSON.stringify(label)}]`))) bad.push(`red-required control "${label}" is missing`)
    // every Aljex flag is a chip; nothing of the old accordions is left
    const absent = []
    for (const k of facts.flags) if (!(await has(b, tid(`f-shipping-flag-${k}`)))) absent.push(`f-shipping-flag-${k}`)
    for (const id of ['f-shipping-shipmentType', 'f-shipping-weightLbs', 'f-shipping-pieces', 'f-shipping-footage', 'f-shipping-freightClass', 'f-shipping-declaredValue', 'f-shipping-description', 'f-shipping-equipmentType', 'f-shipping-revDivision', 'f-shipping-customerMiles', 'f-shipping-milesEdit', 'f-shipping-disableMileage', 'f-shipping-calculateTotals', 'f-customer-email-1', 'f-customer-email-2']) if (!(await has(b, tid(id)))) absent.push(id)
    if (absent.length) bad.push(`missing controls: ${absent.join(', ')}`)
    if (await has(b, '[data-section-toggle]')) bad.push('an accordion toggle is still on the page')
    if (await has(b, tid('f-customer-hours'))) bad.push('Customer Hours is still on the form (removed in AR)')
    // the rail
    for (const id of ['ship-form-rail', 'rail-customer', 'rail-lane', 'rail-freight', 'rail-money', 'rail-required', 'rail-roles', 'ship-form-actionbar', 'ship-form-save-draft', 'ship-form-create']) if (!(await has(b, tid(id)))) bad.push(`rail lacks ${id}`)
    // Carrier is a collapsed card on a brokered create
    if (!(await has(b, tid('carrier-empty')))) bad.push('the Carrier card is not collapsed to "No carrier yet"')
    // Tab order: the main column top to bottom, then the rail
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-customer-name-input'))})?.focus()`)
    const seen = []
    for (let i = 0; i < 160; i += 1) {
      await b.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
      await b.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
      seen.push(await b.evaluate(`(() => { const a = document.activeElement; const c = a?.closest('.tms-ship-card, [data-testid="ship-form-rail"]'); return c?.dataset.testid ?? '' })()`))
    }
    const order = seen.filter((x, i, all) => x && all.indexOf(x) === i)
    // Bill To, Rate history and Tracking hold no inputs, so the Tab walk skips them
    const wantOrder = ['freight', 'route', 'rates', 'carrier', 'documents'].map((k) => `section-${k}`).concat('ship-form-rail')
    const got = order.filter((x) => wantOrder.includes(x))
    if (got.join() !== wantOrder.slice(0, got.length).join() || got.length < 5) bad.push(`Tab order ${got.join(' > ')}`)
    for (const width of [1440, 1280]) {
      await b.setViewport(width, 900); await pause(300)
      const ov = await overflowOf(b)
      if (ov > 1) bad.push(`horizontal scroll of ${ov}px at ${width}px`)
    }
    await b.setViewport(1440, 900)
    await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
    await shotFile(b, '04-00-form-top')
    for (const [n, [key]] of SECTIONS.entries()) {
      await b.evaluate(`document.querySelector(${JSON.stringify(tid(`section-${key}`))}).scrollIntoView({ block: 'start' })`)
      await pause(200)
      await shotFile(b, `04-${String(n + 1).padStart(2, '0')}-card-${key}`)
    }
    failures([...bad, ...problemList(b).slice(0, 2)])
    return `header strip (title, Customer, Bill To chip, Draft chip, PRO preview), 6 numbered cards in order (Carrier & Tracking merged), Division then Shipment type first in Freight, ${reds.length} red-required controls, ${facts.flags.length} flag chips, Carrier collapsed, rail present, Tab order ${got.join(' > ')}, no horizontal scroll at 1440 / 1280`
  },

  async AH05(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    const bad = []
    const tabs = await b.evaluate(`[...document.querySelectorAll('[role="tab"][data-testid^="more-tab-"]')].map((t) => t.dataset.testid.slice(9))`)
    if (tabs.join() !== MORE_TABS.join()) bad.push(`More tabs on create: ${tabs.join()} ≠ ${MORE_TABS.join()}`)
    for (const k of MORE_TABS) {
      await click(b, `more-tab-${k}`); await pause(120)
      const state = await b.evaluate(`(() => { const t = document.querySelector(${JSON.stringify(tid(`more-tab-${k}`))}); const open = [...document.querySelectorAll('[data-more-tab]')].filter((p) => !p.hidden).map((p) => p.dataset.moreTab); return { sel: t.getAttribute('aria-selected'), open } })()`)
      if (state.sel !== 'true' || state.open.join() !== k) bad.push(`${k}: selected ${state.sel}, visible panels ${state.open.join()}`)
    }
    if (await countOf(b, '[role="tab"][data-testid^="more-tab-"]') !== 4) bad.push('the More strip is not exactly four tabs')
    failures(bad)
    return 'More strip: Instructions, References, Items, Notes switch one panel at a time; Documents, Rate history, Tracking are cards, not tabs'
  },

  async AH06(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    const url = await pathOf(b)
    await click(b, 'ship-form-create')
    await b.poll(() => has(b, tid('ship-form-issues')), 'issues strip', 15_000)
    const text = await b.evaluate(`document.querySelector(${JSON.stringify(tid('ship-form-issues'))}).innerText`)
    const bad = []
    for (const name of ['Equipment', 'Division', 'Weight', 'Description']) if (!text.includes(name)) bad.push(`issues strip does not name ${name}`)
    if ((await pathOf(b)) !== url) bad.push('Create on an empty form navigated away')
    const rail = await textOf(b, 'rail-required-count')
    if (!/^[01] \/ \d+$/.test(rail ?? '')) bad.push(`rail checklist reads ${JSON.stringify(rail)} on an empty form`)
    if ((await b.evaluate(`document.querySelectorAll('[data-testid^="rail-req-"][data-missing="true"]').length`)) === 0) bad.push('no rail row turned amber after the blocked attempt')
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
    await pause(4_000)
    expect(!(await b.evaluate(`Object.keys(localStorage).some((k) => k.includes('ship-form:draft'))`)), 'the draft was written before the 10 s autosave interval')
    await pause(7_500) // autosave every 10 s
    expect(await b.evaluate(`Object.keys(localStorage).some((k) => k.includes('ship-form:draft'))`), 'no local draft after the 10 s autosave interval')
    await b.reload(); await b.poll(() => has(b, tid('ship-form-drafts')), 'resume banner', 60_000)
    await shotFile(b, '07-resume-draft-banner')
    await b.click({ selector: '[data-testid^="ship-form-draft-resume-"]' }); await pause(500)
    const restored = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-description'))}).value`)
    expect(restored === 'ZZ AH local draft probe', `Resume did not restore the Description (got ${JSON.stringify(restored)})`)
    await b.reload(); await b.poll(() => has(b, tid('ship-form-drafts')), 'resume banner (2)', 60_000)
    await b.click({ selector: '[data-testid^="ship-form-draft-discard-"]' }); await pause(400)
    expect(!(await has(b, tid('ship-form-drafts'))), 'Discard left the banner on screen')
    return 'a typed Description is autosaved after 10 s (not before), survives a reload as a local draft, Resume restores it, Discard clears it'
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
    for (let n = 1; n <= 2; n += 1) await fill(b, `f-customer-email-${n}`, `zz-ah-${n}-${ctx.ts}@example.invalid`)
    await fill(b, 'f-customer-refNo', ctx.refPo)
    // Shipping Requirements
    await fill(b, 'f-shipping-equipmentType', 'Dry Van')
    ctx.revDivision = await selectFirst(b, 'f-shipping-revDivision')
    await overrideMiles(b, '500')
    await fill(b, 'f-shipping-footage', '48')
    await fill(b, 'f-shipping-pieces', '10')
    await fill(b, 'f-shipping-weightLbs', '12000')
    await fill(b, 'f-shipping-description', ctx.commodity)
    await fill(b, 'f-shipping-declaredValue', '5000')
    await check(b, 'f-shipping-liftgate'); await check(b, 'f-shipping-inside')
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
    await click(b, 'f-route-addPickup-1')
    await b.poll(() => has(b, tid('f-stop-1-name')), 'inserted pick fields', 10_000)
    await pickFrom(b, tid('f-stop-1-name'), tid('f-stop-1-name-option'), ctx.locNames.pick2)
    await fill(b, 'f-stop-1-appt', localDt(1, 12))
    await click(b, 'f-route-addDelivery-2')
    await b.poll(() => has(b, tid('f-stop-2-name')), 'inserted stop fields', 10_000)
    await pickFrom(b, tid('f-stop-2-name'), tid('f-stop-2-name-option'), ctx.locNames.stop2)
    await fill(b, 'f-stop-2-appt', localDt(2, 12))
    // Roles, More Information
    // Sales Representative is a RepPicker (not a <select>); the ZZ customer's default rep prefills it.
    await fill(b, 'f-more-specialInstructions', 'S'.repeat(420))
    await fill(b, 'f-more-rateConNotes', 'R'.repeat(260))
    await b.setViewport(1440, 1800); await pause(400)
    await shotAR(b, 'create-brokered-1440')
    await b.setViewport(1280, 1800); await pause(400)
    await shotAR(b, 'create-brokered-1280')
    await b.setViewport(1440, 900); await pause(300)
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
    eq('liftgate', sr.liftgate, true); eq('inside', sr.inside, true)
    eq('tempControl', sr.tempControl, true); eq('tarps', sr.tarps, true); eq('palletExchange', sr.palletExchange, true)
    eq('tempF mirror (2-4 °C → °F)', [sr.tempF?.min, sr.tempF?.max], [36, 39])
    eq('form.ship.temp', [form.ship?.temp?.unit, form.ship?.temp?.min, form.ship?.temp?.max], ['C', 2, 4])
    eq('form.ship.truckMiles (same value as the one Miles field)', form.ship?.truckMiles, 500)
    eq('form.customer.emails', form.customer?.emails?.length, 2)
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
    await eq('f-shipping-tempMin', '2')
    await eq('f-shipping-tempMax', '4')
    await eq('f-shipping-palletsIn', '3')
    await eq('f-customer-refNo', ctx.refPo)
    await eq('f-rates-customerHours', '2')
    await eq('f-rates-fscPercent', '10')
    await eq('f-pickup-refNo', ctx.refPickup)
    await eq('f-consignee-refNo', ctx.refDelivery)
    for (const k of ctx.flagsTicked) {
      const on = await b.evaluate(`document.querySelector(${JSON.stringify(tid(`f-shipping-flag-${k}`))})?.checked ?? null`)
      if (on !== true) bad.push(`flag ${k} reloads unticked`)
    }
    await shotFile(b, '11-edit-mode-reloaded')
    const editTitle = await textOf(b, 'ship-form-title')
    if (!/^Edit PRO /.test(editTitle ?? '')) bad.push(`edit title is ${JSON.stringify(editTitle)}`)
    if (!(await has(b, tid('card-tracking-updates')))) bad.push('edit mode lacks the Updates feed in the Carrier & Tracking card')
    await b.setViewport(1440, 1800); await pause(400); await shotAR(b, 'edit-1440')
    await b.setViewport(1280, 1800); await pause(400); await shotAR(b, 'edit-1280')
    await b.setViewport(1440, 900)
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
    const modeDisabled = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-shipmentType'))})?.disabled ?? null`)
    if (modeDisabled !== true) bad.push(`Shipment type is ${modeDisabled === null ? 'missing' : 'still editable'} on a submitted order`)
    await shotFile(b, '13-edit-live-locked-fields')
    await fill(b, 'f-shipping-description', `${ctx.commodity} edited`)
    await overrideMiles(b, '650')
    await click(b, 'ship-form-save')
    await b.poll(async () => (await getBundle(ctx, ctx.fullId)).loads[0]?.commodity?.endsWith('edited') === true || await has(b, tid('ship-form-issues')), 'edit saved', 45_000)
    const after = await getBundle(ctx, ctx.fullId)
    if (after.loads[0]?.commodity !== `${ctx.commodity} edited`) bad.push(`commodity is ${JSON.stringify(after.loads[0]?.commodity)} after Save changes`)
    if (after.loads[0]?.miles !== 650) bad.push(`miles is ${after.loads[0]?.miles} after Save changes (wanted 650)`)
    const audit = await listAll(ctx.token, 'AuditLog', { entityId: { eq: ctx.fullId }, action: { eq: 'UPDATE_ORDER_DETAILS' } }, 'id')
    if (audit.length === 0) bad.push('no UPDATE_ORDER_DETAILS audit row after editing a non-draft shipment')
    failures(bad)
    return `Save changes on an OPEN order wrote through UPDATE_ORDER_DETAILS (${audit.length} audit rows); Shipment type is locked`
  },

  async AH14(ctx) {
    expect(ctx.submitted, 'AH12 did not submit the order')
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    expect(await has(b, tid('carrier-empty')), 'the Carrier card is not collapsed to "No carrier yet" on a shipment without a carrier')
    await click(b, 'carrier-assign')
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
      const reason = await b.evaluate(`document.querySelector(${JSON.stringify(tid('carrier-cover-reason'))})?.innerText ?? ''`)
      throw new Error(`Cover did not open the booking dialog (${JSON.stringify(reason)})`)
    }
    await shotFile(b, '14-cover-dialog')
    const text = await b.evaluate(`[...document.querySelectorAll('[role="dialog"]')].pop().innerText`)
    expect(/book|cover|carrier/i.test(text), 'the dialog that opened is not the carrier booking dialog')
    await b.press('Escape'); await pause(300)
    return 'Carrier card: collapsed "No carrier yet" → Assign picks the directory carrier; Cover opens the Step AM ladder dialog (not confirmed: booking a carrier is out of scope here)'
  },

  // ── Ryne's feedback round (AH15-AH20): run at 1440 px, light theme ──
  async AH15(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 1400)
    await openForm(b, '/tms/shipments/new')
    const facts = await b.evaluate(`(() => {
      const mainText = document.querySelector('.tms-ship-form').innerText;
      const stars = [...document.querySelectorAll('.tms-ship-form label')].filter((l) => /\\s\\*\\s*$/.test(l.textContent)).length;
      const req = document.querySelector('.tms-field-req input, .tms-field-req select');
      const plain = [...document.querySelectorAll('.tms-field:not(.tms-field-req) input.tms-input')].find((i) => !i.disabled && !i.readOnly);
      const rgb = (el) => getComputedStyle(el).borderColor + '|' + getComputedStyle(el).backgroundColor;
      const green = (c) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(c); return !!m && Number(m[2]) > Number(m[1]) && Number(m[2]) >= Number(m[3]); };
      return { stars, hasReq: !!req, reqStyle: req ? rgb(req) : '', plainStyle: plain ? rgb(plain) : '', reqCount: document.querySelectorAll('.tms-field-req').length, anyGreen: req ? green(getComputedStyle(req).borderColor) || green(getComputedStyle(req).backgroundColor) : false, mainText: mainText.length };
    })()`)
    const bad = []
    if (facts.stars > 0) bad.push(`${facts.stars} labels still end in an asterisk`)
    if (!facts.hasReq) bad.push('no .tms-field-req wrapper on the form')
    if (facts.reqStyle === facts.plainStyle) bad.push('a required input looks the same as an optional one')
    if (!facts.anyGreen) bad.push(`required input is not green (${facts.reqStyle})`)
    await shotFile2(b, '15-required-style')
    failures(bad)
    return `${facts.reqCount} required fields styled green, no asterisks`
  },

  async AH16(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    const emailInputs = await b.evaluate(`document.querySelectorAll('[data-testid^="f-customer-email-"]').length`)
    expect(emailInputs === 2, `${emailInputs} customer e-mail fields, wanted 2`)
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await b.poll(() => has(b, tid('f-customer-billToBlock')), 'Bill To block', 10_000)
    await click(b, 'hdr-billTo-chip'); await pause(200)
    const bad = []
    const rowText = (k) => b.evaluate(`document.querySelector(${JSON.stringify(tid(`f-customer-billTo-${k}`))})?.innerText ?? null`)
    for (const k of ['terms', 'factoring', 'emails', 'limit', 'available']) {
      const t = await rowText(k)
      if (t == null) bad.push(`Bill To block has no ${k} row`)
    }
    const editable = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-customer-billToBlock'))}).querySelectorAll('input:not([readonly]):not([disabled]), textarea, select').length`)
    if (editable > 0) bad.push(`Bill To block has ${editable} editable controls (it must be read-only)`)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('ship-form-header'))}).scrollIntoView({ block: 'start' })`)
    await shotFile2(b, '16-customer-bill-to')
    failures(bad)
    return `2 customer e-mail fields; Bill To block shows terms, factoring, billing e-mails and credit for the ZZ customer read-only`
  },

  async AH17(ctx) {
    const b = ctx.b
    await openForm(b, '/tms/shipments/new')
    await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
    await pickFrom(b, tid('f-consignee-name'), tid('f-consignee-name-option'), ctx.locNames.receiver)
    const read = (id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.value ?? ''`)
    await b.poll(async () => Number(await read('f-shipping-customerMiles')) > 0, 'Customer Miles auto-filled', 30_000).catch(async (err) => {
      throw new Error(`${err.message} (lane ${JSON.stringify(await textOf(b, 'f-route-lane'))}, pickup line ${JSON.stringify(await textOf(b, 'f-pickup-addressLine'))}, hint ${JSON.stringify(await textOf(b, 'f-shipping-milesSource'))}, problems ${JSON.stringify(problemList(b).slice(0, 3))})`)
    })
    const miles = Number(await read('f-shipping-customerMiles'))
    const truck = miles
    const bad = []
    if (!(miles > 500 && miles < 1300)) bad.push(`Chicago to Dallas came out as ${miles} miles`)
    if (await has(b, '[data-testid="f-shipping-' + 'truckMiles"]')) bad.push('a separate Truck Miles field is still on the form')
    if (!(await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-customerMiles'))})?.readOnly === true`))) bad.push('Miles is not read-only')
    const source = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-milesSource'))})?.innerText ?? ''`)
    await overrideMiles(b, '777'); await pause(1500)
    if ((await read('f-shipping-customerMiles')) !== '777') bad.push('an overridden Miles was overwritten by the calculation')
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('section-route'))}).scrollIntoView({ block: 'start' })`)
    await shotFile2(b, '17-auto-miles')
    failures(bad)
    return `one Miles field (${miles}) calculated from the two stops (${JSON.stringify(source.slice(0, 60))}); an override sticks`
  },

  async AH18(ctx) {
    expect(ctx.fullId, 'AH09 did not create a shipment')
    const b = ctx.b
    const bad = []
    // create: the Carrier & Tracking card shows the planned setup (customer suggestion greyed), no mode control, never check-call entry
    await openForm(b, '/tms/shipments/new')
    if (!(await has(b, tid('card-tracking-planned')))) bad.push('create: the Carrier & Tracking card does not show the planned setup')
    if (await has(b, tid('tracking-mode-control'))) bad.push('create: the tracking mode control is shown before a carrier is booked')
    if (!/Tracking is chosen when the carrier is booked/i.test((await textOf(b, 'card-tracking-body')) ?? '')) bad.push('create: no "Tracking is chosen when the carrier is booked" line')
    if (await has(b, tid('card-tracking-updates'))) bad.push('create: the Updates feed is on the create form')
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('card-tracking-body'))}).scrollIntoView({ block: 'start' })`)
    await pause(300)
    const facts = await b.evaluate(`(() => {
      const s = document.querySelector('[data-testid="card-tracking-body"]');
      const link = s.querySelector('[data-testid="card-tracking-open"]');
      return { facts: !!s.querySelector('[data-testid="card-tracking-facts"]'), link: link?.getAttribute('href') ?? null, inputs: [...s.querySelectorAll('input:not([type=checkbox]), textarea, select')].filter((i) => !i.closest('[data-testid="tracking-mode-control"]')).length, control: !!s.querySelector('[data-testid="tracking-mode-control"]'), updates: !!s.querySelector('[data-testid="card-tracking-updates"]'), status: s.querySelector('[data-testid="card-tracking-status"]')?.innerText ?? null };
    })()`)
    if (!facts.control) bad.push('edit: no TrackingModeControl in the Carrier & Tracking card')
    if (!facts.facts) bad.push('edit: no tracking facts block')
    if (!facts.link || !facts.link.includes('/tms/tracking')) bad.push(`"Open in Load Tracking" link is ${JSON.stringify(facts.link)}`)
    if (facts.inputs > 0) bad.push(`the tracking read has ${facts.inputs} entry inputs outside the mode control (read-only)`)
    if (!facts.updates) bad.push('edit: the Updates feed is not inside the Carrier & Tracking card')
    await shotFile2(b, '18-tracking-card')
    failures(bad)
    return `Carrier & Tracking card: planned setup on create (no control, no entry, no Updates); in edit mode the mode control + read-only facts (status ${JSON.stringify(facts.status)}), Open in Load Tracking link and the Updates feed`
  },

  async AH19(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    for (const [n, [key]] of SECTIONS.entries()) {
      await b.evaluate(`document.querySelector(${JSON.stringify(tid(`section-${key}`))}).scrollIntoView({ block: 'start' })`)
      await pause(250)
      await shotFile2(b, `19-${String(n + 1).padStart(2, '0')}-card-${key}`)
    }
    const overflow = await overflowOf(b)
    expect(overflow <= 1, `horizontal scroll of ${overflow}px at 1440`)
    return '5 card screenshots at 1440 px (Docs/tms-build/screenshots/ah2)'
  },

  async AH20(ctx) {
    const b = ctx.b
    expect(ctx.suffix, 'no AWS access to stage an intake row (the harness needs the dev tables)')
    const id = `il:zz-ah-${ctx.ts}`
    ctx.intakeId = id
    const stop = (type, name, city, state, zip, date, time) => ({ type, name, street: '1 ZZ Test Way', city, state, zip, date, time, instructions: type === 'pickup' ? 'ZZ AH dock 4' : null })
    const fields = {
      customerId: ctx.customerId, customerName: ctx.customerName, billToId: null, salesRepId: null, divisionCode: null,
      reference: `ZZ-AH-INTAKE-PO-${ctx.ts}`, pickupNumber: `ZZ-AH-INTAKE-PU-${ctx.ts}`, deliveryNumber: null,
      equipmentType: 'Reefer', commodity: `ZZ AH intake freight ${ctx.ts}`, weightLb: 18000, customerRateCents: 250000,
      stops: [stop('pickup', ctx.locNames.shipper, 'Chicago', 'IL', '60601', localDay(2), '09:00'), stop('delivery', ctx.locNames.receiver, 'Dallas', 'TX', '75201', localDay(4), null)],
    }
    const now = new Date().toISOString()
    await doc.send(new PutCommand({ TableName: devTable('IntakeLoad', ctx.suffix), Item: {
      __typename: 'IntakeLoad', id, status: 'OPEN', divisionCode: null, toAddress: null, toAddresses: [], runId: `zz-ah-run-${ctx.ts}`, sourceKey: null,
      subject: `ZZ AH tender ${ctx.ts}`, fromEmail: `zz-ah-sender-${ctx.ts}@example.invalid`, fromName: 'ZZ AH Sender', receivedAt: now, bodyText: 'ZZ AH harness tender',
      attachments: JSON.stringify([]), parseState: 'PARSED', parseNote: null, format: 'harness', fields: JSON.stringify(fields), autoFields: JSON.stringify(fields), meta: JSON.stringify({}),
      confirmed: [], missingFields: [], shipmentId: null, shipmentNumber: null, createdBy: 'zz-ah-harness', updatedBy: 'zz-ah-harness', version: 1, createdAt: now, updatedAt: now,
    } }))
    await openForm(b, `/tms/shipments/new?intake=${encodeURIComponent(id)}`)
    await b.poll(() => has(b, tid('ship-form-intake-banner')), 'the pre-fill banner', 30_000)
    const val = (testId) => b.evaluate(`document.querySelector(${JSON.stringify(tid(testId))})?.value ?? null`)
    const bad = []
    const eq = (label, got, want) => { if (got !== want) bad.push(`${label}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`) }
    eq('equipment', await val('f-shipping-equipmentType'), 'Reefer')
    eq('weight', await val('f-shipping-weightLbs'), '18000')
    eq('description', await val('f-shipping-description'), fields.commodity)
    eq('customer ref', await val('f-customer-refNo'), fields.reference)
    eq('pickup ref', await val('f-pickup-refNo'), fields.pickupNumber)
    eq('customer LH rate', await val('f-rates-customerLhRate'), '2500.00')
    eq('pickup city', await val('f-pickup-city'), 'Chicago')
    eq('consignee city', await val('f-consignee-city'), 'Dallas')
    const chips = await b.evaluate(`[...document.querySelectorAll('[data-testid$="-from-email"]')].map((n) => n.getAttribute('data-testid'))`)
    for (const want of ['f-shipping-equipmentType-from-email', 'f-shipping-weightLbs-from-email', 'f-pickup-city-from-email', 'f-consignee-city-from-email']) {
      if (!chips.includes(want)) bad.push(`no "from e-mail" chip on ${want.replace('-from-email', '')}`)
    }
    await shotFile2(b, '20-intake-prefill')
    // Intake board: the row offers Create shipment
    failures(bad)
    ctx.intakePrefilled = chips.length
    return `${chips.length} fields pre-filled and marked from the intake load`
  },

  async AH21(ctx) {
    const b = ctx.b
    expect(ctx.intakePrefilled, 'AH20 did not pre-fill')
    ctx.revDivision = await selectFirst(b, 'f-shipping-revDivision')
    await fill(b, 'f-shipping-weightLbs', '18000')
    await click(b, 'ship-form-create')
    const sid = await waitEditUrl(ctx, b, 'create from intake')
    const linked = await b.poll(async () => {
      const r = await gql(ctx.token, 'query($id: ID!) { getIntakeLoad(id: $id) { status shipmentId } }', { id: ctx.intakeId })
      return r.getIntakeLoad?.status === 'MOVED' && r.getIntakeLoad?.shipmentId === sid
    }, 'intake load linked to the new shipment', 30_000).then(() => true, () => false)
    expect(linked, 'the intake load was not marked MOVED and linked to the shipment created from it')
    return `shipment ${sid} created from the pre-filled form; intake load is MOVED and linked`
  },
  // ── Step AR: layout, rail, keyboard (1440 x 900 unless a step says otherwise) ──
  async AR01(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    const url = await pathOf(b)
    // Ctrl+Enter and Cmd+Enter = Create: blocked on an empty form, the strip and the rail say what is missing
    await chord(b, 'Enter', 2)
    await b.poll(() => has(b, tid('ship-form-issues')), 'issues strip after Ctrl+Enter', 15_000).catch(() => bad.push('Ctrl+Enter did not run Create (no issues strip)'))
    if ((await pathOf(b)) !== url) bad.push('Ctrl+Enter on an empty form navigated away')
    await b.reload(); await b.poll(() => has(b, tid('ship-form')), 'form', 60_000); await pause(600)
    await chord(b, 'Enter', 4)
    await b.poll(() => has(b, tid('ship-form-issues')), 'issues strip after Cmd+Enter', 15_000).catch(() => bad.push('Cmd+Enter did not run Create'))
    // Ctrl+S = Save draft: no customer, so it stays a local draft
    await chord(b, 's', 2)
    await b.poll(async () => /local draft/i.test(await bodyText(b)), 'local-draft notice after Ctrl+S', 8_000).catch(() => bad.push('Ctrl+S did not run Save draft'))
    // Esc closes the customer picker
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-customer-name-input'))}).focus()`)
    await setValue(b, tid('f-customer-name-input'), 'ZZ AH')
    await b.poll(() => has(b, '[role="listbox"]'), 'customer suggestions', 15_000).catch(() => bad.push('no customer suggestions to close'))
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-customer-name-input'))}).focus()`)
    await b.press('Escape'); await pause(200)
    if (await has(b, '[role="listbox"]')) bad.push('Esc did not close the customer picker')
    // rail: clicking a missing row scrolls to and focuses the field
    for (const [row, field] of [['weight', 'f-shipping-weightLbs'], ['description', 'f-shipping-description'], ['pickup', 'f-pickup-name'], ['customer', 'f-customer-name-input']]) {
      await b.evaluate(`document.querySelector('.tms-ship-form-scroll').scrollTo(0, 0)`)
      await click(b, `rail-req-${row}`); await pause(250)
      const at = await activeId(b)
      const r = await rectOf(b, tid(field))
      if (at !== field) bad.push(`rail row ${row} focused ${JSON.stringify(at)}, wanted ${field}`)
      if (!r || r.top < 0 || r.bottom > 900) bad.push(`rail row ${row}: ${field} is not scrolled into view (${JSON.stringify(r)})`)
    }
    // Ctrl+S with a customer = a server draft, landing on the edit URL
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await chord(b, 's', 2)
    const id = await waitEditUrl(ctx, b, 'Ctrl+S draft')
    const status = (await getBundle(ctx, id)).shipment.status
    if (status !== 'DRAFT') bad.push(`Ctrl+S made a ${status}, wanted DRAFT`)
    failures(bad)
    return 'Ctrl+Enter and Cmd+Enter run Create (blocked, rail + strip explain), Ctrl+S saves (local without a customer, server draft with one), Esc closes the picker, rail rows scroll to and focus weight / description / pickup / customer'
  },

  async AR02(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await fill(b, 'f-shipping-weightLbs', '12000')
    await fill(b, 'f-shipping-description', ctx.commodity)
    await pause(300)
    const count = await textOf(b, 'rail-required-count')
    const m = /^(\d+) \/ (\d+)$/.exec(count ?? '')
    if (!m) throw new Error(`rail count reads ${JSON.stringify(count)}`)
    const [done, total] = [Number(m[1]), Number(m[2])]
    const doneRows = await countOf(b, '[data-testid^="rail-req-"][data-done="true"]')
    if (doneRows !== done) bad.push(`rail says ${done} done but ${doneRows} rows are ticked`)
    const urlBefore = await pathOf(b)
    await click(b, 'ship-form-create')
    await b.poll(() => has(b, tid('ship-form-issues')), 'issues strip', 15_000)
    const listed = await countOf(b, '[data-testid^="issue-link-"]')
    if (listed !== total - done) bad.push(`rail N / M = ${done} / ${total} but Create blocked on ${listed} issues (want ${total - done})`)
    if ((await pathOf(b)) !== urlBefore) bad.push('Create navigated although the checklist is incomplete')
    // fill the rest: the checklist reaches M / M, the rail turns green and Create goes through
    await fill(b, 'f-shipping-equipmentType', 'Dry Van'); await selectFirst(b, 'f-shipping-revDivision')
    await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
    await fill(b, 'f-pickup-ready', localDt(1, 7)); await pause(300)
    const full = await textOf(b, 'rail-required-count')
    if (!/^(\d+) \/ \1$/.test(full ?? '')) bad.push(`rail did not reach M / M on a complete form (${full})`)
    if ((await b.evaluate(`document.querySelector(${JSON.stringify(tid('rail-required-count'))}).dataset.ready`)) !== 'true') bad.push('the count is not marked ready')
    // The rail scrolls with the page (feedback 19); the action bar stays put and Create stays reachable.
    await b.evaluate(`document.querySelector('.tms-ship-form-scroll').scrollTo(0, 600)`)
    await pause(250)
    const barRect = await rectOf(b, tid('ship-form-actionbar'))
    if (!barRect || barRect.bottom > 901 || barRect.top < 700) bad.push(`the action bar is not at the foot of the screen after scrolling (${JSON.stringify(barRect)})`)
    await shotAR(b, 'rail-sticky-scrolled-1440')
    await b.evaluate(`document.querySelector('.tms-ship-form-scroll').scrollTo(0, 0)`)
    await click(b, 'ship-form-create')
    const id = await waitEditUrl(ctx, b, 'rail-complete create')
    failures(bad)
    return `rail ${done} / ${total} on a half-filled form matched ${listed} blocking issues; M / M after the rest (${id} created); action bar stayed at the foot after scrolling`
  },

  async AR03(ctx) {
    const b = ctx.b
    await b.setViewport(1100, 800)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    const vis = (id) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(tid(id))}); return !!e && e.getClientRects().length > 0 })()`)
    if (!(await vis('rail-sheet-toggle'))) bad.push('no bottom-sheet bar below 1280 px')
    if (await vis('rail-money')) bad.push('the rail body shows before the sheet is opened')
    if (!(await vis('ship-form-create')) || !(await vis('ship-form-save-draft'))) bad.push('the action bar is not visible below 1280 px')
    const bar = await textOf(b, 'rail-sheet-toggle')
    if (!/Net .* · /.test(bar ?? '')) bad.push(`sheet bar lacks the money line (${JSON.stringify(bar)})`)
    const rail = await rectOf(b, tid('ship-form-rail'))
    if (!rail || rail.bottom > 801 || rail.bottom < 700) bad.push(`the sheet is not pinned to the bottom (${JSON.stringify(rail)})`)
    await shotAR(b, 'sheet-closed-1100')
    await click(b, 'rail-sheet-toggle'); await pause(250)
    if (!(await vis('rail-money')) || !(await vis('rail-required'))) bad.push('opening the sheet does not reveal the money block and checklist')
    await shotAR(b, 'sheet-open-1100')
    await click(b, 'rail-sheet-toggle'); await pause(200)
    if (await vis('rail-money')) bad.push('the sheet did not collapse again')
    const ov = await overflowOf(b)
    if (ov > 1) bad.push(`horizontal scroll of ${ov}px at 1100`)
    // at 1280 and above it is the 360 px column
    for (const width of [1280, 1440]) {
      await b.setViewport(width, 900); await pause(300)
      const r = await rectOf(b, tid('ship-form-rail'))
      if (await vis('rail-sheet-toggle')) bad.push(`the sheet bar is still visible at ${width}`)
      if (!r || Math.abs(r.width - 360) > 2) bad.push(`the rail is ${r?.width}px wide at ${width} (want 360)`)
    }
    failures(bad)
    return 'below 1280 the rail is a bottom sheet (money line + actions pinned, body opens/closes); at 1280 and 1440 it is the 360 px column'
  },

  async AR04(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    const stops = () => b.evaluate(`[...document.querySelectorAll('.tms-card-stop')].map((s) => s.dataset.type)`)
    if ((await stops()).join() !== 'pickup,delivery') bad.push(`a new form starts with ${(await stops()).join()}`)
    await fill(b, 'f-pickup-refNo', 'AAA')
    await click(b, 'f-route-addPickup-1')
    await b.poll(() => has(b, tid('f-stop-1-refNo')), 'inserted stop', 10_000)
    await fill(b, 'f-stop-1-refNo', 'BBB')
    if ((await stops()).join() !== 'pickup,pickup,delivery') bad.push(`after + Add pickup: ${(await stops()).join()}`)
    // the first stop must stay a pickup and the last a delivery: no delivery can be added at the top, no pickup after the last
    if ((await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-route-addDelivery-0'))})?.disabled ?? 'none'`)) === false) bad.push('a delivery can be inserted before the first pickup')
    // reorder with the handle (arrow down moves the stop down one)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-route-handle-0'))}).focus()`)
    await b.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 })
    await b.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 })
    await pause(300)
    const first = await valOf(b, 'f-pickup-refNo'); const second = await valOf(b, 'f-stop-1-refNo')
    if (first !== 'BBB' || second !== 'AAA') bad.push(`reorder: first ${first}, second ${second} (want BBB, AAA)`)
    // delete with undo
    await click(b, 'f-route-remove-1'); await pause(250)
    if ((await stops()).join() !== 'pickup,delivery') bad.push(`after delete: ${(await stops()).join()}`)
    if (!(await has(b, tid('f-route-undo')))) bad.push('no Undo after deleting a stop')
    await click(b, 'f-route-undoButton'); await pause(250)
    if ((await stops()).join() !== 'pickup,pickup,delivery' || (await valOf(b, 'f-stop-1-refNo')) !== 'AAA') bad.push('Undo did not put the stop back where it was')
    await pickFrom(b, tid('f-stop-1-name'), tid('f-stop-1-name-option'), ctx.locNames.pick2)
    // lane header: origin → destination, miles inputs, transit estimate
    await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
    await pickFrom(b, tid('f-consignee-name'), tid('f-consignee-name-option'), ctx.locNames.receiver)
    await b.poll(async () => Number(await valOf(b, 'f-shipping-customerMiles')) > 0, 'miles', 30_000)
    const lane = await textOf(b, 'f-route-lane')
    if (!/Chicago, IL → Dallas, TX/.test(lane ?? '')) bad.push(`lane header reads ${JSON.stringify(lane)}`)
    const transit = await textOf(b, 'f-route-transit')
    const miles = Number(await valOf(b, 'f-shipping-customerMiles'))
    if (!new RegExp(`${Math.max(1, Math.ceil(miles / 500))} days?`).test(transit ?? '')) bad.push(`transit ${JSON.stringify(transit)} for ${miles} mi`)
    const railLane = await textOf(b, 'rail-lane')
    if (!/Chicago, IL → Dallas, TX/.test(railLane ?? '')) bad.push(`rail lane line reads ${JSON.stringify(railLane)}`)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('section-route'))}).scrollIntoView({ block: 'start' })`)
    await shotAR(b, 'route-timeline-1440')
    failures(bad)
    return `timeline: + Add pickup, handle reorder, delete + Undo restore, order rule enforced; lane header "${lane}" · ${transit} (${miles} mi), mirrored in the rail`
  },

  async AR05(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    const sub = async (ids) => { const out = []; for (const id of ids) out.push(await has(b, tid(id))); return out }
    if ((await sub(['f-shipping-tempMin', 'f-shipping-palletsIn', 'f-shipping-tarpSize', 'f-shipping-subfields'])).some(Boolean)) bad.push('sub-fields show before any chip is on')
    await check(b, 'f-shipping-tempControl')
    if (!(await has(b, tid('f-shipping-tempMin')))) bad.push('Temp control did not reveal Min / Max Temp')
    await check(b, 'f-shipping-palletExchange')
    if (!(await has(b, tid('f-shipping-palletsIn')))) bad.push('Pallet exchange did not reveal its counts')
    await check(b, 'f-shipping-tarps')
    if (!(await has(b, tid('f-shipping-tarpSize')))) bad.push('Tarps did not reveal Tarp Size')
    await shotAR(b, 'chips-subfields-1440')
    for (const [chip, field] of [['f-shipping-tempControl', 'f-shipping-tempMin'], ['f-shipping-palletExchange', 'f-shipping-palletsIn'], ['f-shipping-tarps', 'f-shipping-tarpSize']]) {
      await click(b, chip); await pause(150)
      if (await has(b, tid(field))) bad.push(`${field} stays after ${chip} is turned off`)
    }
    await click(b, 'f-shipping-flag-hazmat'); await pause(100)
    const on = await b.evaluate(`document.querySelector(${JSON.stringify(tid('f-shipping-flag-hazmat'))}).closest('.tms-card-chip').dataset.on`)
    if (on !== 'true') bad.push(`the Hazmat chip is not marked on (${on})`)
    const chips = await countOf(b, '.tms-card-chip')
    if (chips !== 22) bad.push(`${chips} requirement chips, wanted 22`)
    failures(bad)
    return `${chips} requirement chips; Temp control, Pallet exchange and Tarps reveal and hide their sub-fields inline`
  },

  async AR06(ctx) {
    const b = ctx.b
    expect(ctx.driverName, 'no ZZ roster driver fixture')
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    await fillRequired(ctx, b, { division: 'ASSETS' })
    await pause(500)
    const card = await b.evaluate(`(() => {
      const body = document.querySelector('[data-testid="section-carrier-body"]');
      const sel = body.querySelector('select[data-testid="f-carrier-driver1"]');
      const typed = [...body.querySelectorAll('input[type="text"], input:not([type])')].filter((i) => /driver/i.test(i.getAttribute('aria-label') ?? '') || /driver/i.test(i.getAttribute('data-testid') ?? '')).length;
      return { select: !!sel, options: sel ? [...sel.options].map((o) => o.textContent) : [], typed, empty: !!body.querySelector('[data-testid="carrier-empty"]') };
    })()`)
    if (!card.select) {
      await shotFile(b, 'AR06-no-roster-picker')
      throw new Error(`the Ivan Cartage division card has no roster picker (Driver 1 select); revDivision ${JSON.stringify(await valOf(b, 'f-shipping-revDivision'))}, options ${JSON.stringify(await b.evaluate(`[...document.querySelector(${JSON.stringify(tid('f-shipping-revDivision'))}).options].map((o) => o.value + '=' + o.textContent.trim())`))}, card text ${JSON.stringify((await b.evaluate(`document.querySelector('[data-testid="section-carrier-body"]').innerText`)).slice(0, 200))}`)
    }
    if (card.typed > 0) bad.push(`${card.typed} free-text driver inputs on the Ivan Cartage card`)
    if (card.empty) bad.push('the Ivan Cartage card is still the collapsed "No carrier yet" card')
    if (!card.options.some((o) => o.includes(ctx.driverName))) bad.push('the ZZ roster driver is not offered')
    const driverId = await b.evaluate(`(() => { const sel = document.querySelector('[data-testid="section-carrier-body"] select[data-testid="f-carrier-driver1"]'); return [...sel.options].find((o) => o.textContent.includes(${JSON.stringify(ctx.driverName)}))?.value ?? null })()`)
    await setValue(b, '[data-testid="section-carrier-body"] select[data-testid="f-carrier-driver1"]', driverId)
    await pause(300)
    const truck = await b.evaluate(`document.querySelector('[data-testid="section-carrier-body"]').innerText`)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('section-carrier'))}).scrollIntoView({ block: 'center' })`)
    await b.setViewport(1440, 1800); await pause(400); await shotAR(b, 'create-ivan-1440')
    await b.setViewport(1280, 1800); await pause(400); await shotAR(b, 'create-ivan-1280')
    await b.setViewport(1440, 900); await pause(300)
    // Ctrl+Enter creates
    await chord(b, 'Enter', 2)
    const id = await waitEditUrl(ctx, b, 'Ivan Cartage create (Ctrl+Enter)')
    const bundle = await getBundle(ctx, id)
    if (bundle.shipment.revDivision !== 'ASSETS') bad.push(`revDivision ${bundle.shipment.revDivision}, wanted ASSETS`)
    const lc = (bundle.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')
    ctx.ivanId = id
    failures(bad)
    return `Ivan Cartage division: roster picker (${card.options.length - 1} drivers, no free text) fills driver/truck; Ctrl+Enter created ${id} (division ASSETS, active carrier leg ${lc ? JSON.stringify(lc.carrierName) : 'none yet'}, driver ${truck.includes(ctx.driverName) ? 'shown' : 'not shown'})`
  },

  async AR07(ctx) {
    const b = ctx.b
    const bad = []
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      await b.setViewport(width, height)
      await b.evaluate(`Object.keys(localStorage).filter((k) => k.includes('ship-form:draft')).forEach((k) => localStorage.removeItem(k))`)
      await openForm(b, '/tms/shipments/new')
      await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
      await pause(400)
      const ov = await overflowOf(b)
      if (ov > 1) bad.push(`horizontal scroll of ${ov}px at ${width}`)
      // first screen: Customer + the Freight card start + the rail with its actions, no scrolling
      const cust = await rectOf(b, tid('ship-form-header')); const route = await rectOf(b, tid('section-freight'))
      const pu = await rectOf(b, tid('f-shipping-equipmentType')); const create = await rectOf(b, tid('ship-form-create'))
      const rail = await rectOf(b, tid('ship-form-rail'))
      if (width === 1440) {
        if (!cust || cust.bottom > height) bad.push(`1440x900: the header strip runs past the first screen (bottom ${Math.round(cust?.bottom)})`)
        if (!route || !pu || pu.bottom > height) bad.push(`1440x900: the Freight card's Equipment field is below the first screen (field bottom ${Math.round(pu?.bottom ?? -1)})`)
        if (!rail || !create || create.bottom > height || rail.top < 0) bad.push(`1440x900: the rail / Create are not on the first screen (create bottom ${Math.round(create?.bottom ?? -1)})`)
        await shotAR(b, 'first-screen-1440x900')
      } else await shotAR(b, 'first-screen-1280x800')
      // (the symmetry of every grid row is asserted by AR14)
    }
    failures(bad)
    return 'no horizontal scroll at 1440 and 1280; at 1440x900 the first screen shows Customer, the Freight card start and the rail with Create; grid symmetry is AR14'
  },

  async AR08(ctx) {
    const b = ctx.b
    expect(ctx.suffix, 'no AWS access to stage an intake row')
    await b.setViewport(1440, 900)
    const id = `il:zz-ar-${ctx.ts}`
    ctx.intakeBoardId = id
    const stop = (type, name, city, state, zip, date) => ({ type, name, street: '1 ZZ Test Way', city, state, zip, date, time: null, instructions: null })
    const fields = {
      customerId: ctx.customerId, customerName: ctx.customerName, billToId: null, salesRepId: null, divisionCode: null,
      reference: `ZZ-AR-INTAKE-${ctx.ts}`, pickupNumber: null, deliveryNumber: null, equipmentType: 'Dry Van', commodity: `ZZ AR intake freight ${ctx.ts}`,
      weightLb: 20000, customerRateCents: 180000,
      stops: [stop('pickup', ctx.locNames.shipper, 'Chicago', 'IL', '60601', localDay(2)), stop('delivery', ctx.locNames.receiver, 'Dallas', 'TX', '75201', localDay(4))],
    }
    const now = new Date().toISOString()
    await doc.send(new PutCommand({ TableName: devTable('IntakeLoad', ctx.suffix), Item: {
      __typename: 'IntakeLoad', id, status: 'OPEN', divisionCode: null, toAddress: null, toAddresses: [], runId: `zz-ar-run-${ctx.ts}`, sourceKey: null,
      subject: `ZZ AR tender ${ctx.ts}`, fromEmail: `zz-ar-sender-${ctx.ts}@example.invalid`, fromName: 'ZZ AR Sender', receivedAt: now, bodyText: 'ZZ AR harness tender',
      attachments: JSON.stringify([]), parseState: 'PARSED', parseNote: null, format: 'harness', fields: JSON.stringify(fields), autoFields: JSON.stringify(fields), meta: JSON.stringify({}),
      confirmed: [], missingFields: [], shipmentId: null, shipmentNumber: null, createdBy: 'zz-ar-harness', updatedBy: 'zz-ar-harness', version: 1, createdAt: now, updatedAt: now,
    } }))
    await b.navigate('/tms/shipments/intake'); await waitLoaded(b)
    await b.click({ pattern: '^Unrouted' }).catch(() => {})
    await pause(800)
    const rowSel = `[data-testid="intake-create-shipment"]`
    await b.poll(async () => (await b.evaluate(`[...document.querySelectorAll('tr, [role="row"]')].some((r) => r.innerText.includes(${JSON.stringify(`ZZ AR tender ${ctx.ts}`)}))`)), 'the staged intake row on the board', 60_000).catch(async (err) => { throw new Error(`${err.message} (page: ${JSON.stringify((await bodyText(b)).replace(/\s+/g, ' ').slice(0, 300))})`) })
    await b.evaluate(`(() => { const r = [...document.querySelectorAll('tr, [role="row"]')].find((x) => x.innerText.includes(${JSON.stringify(`ZZ AR tender ${ctx.ts}`)})); r.querySelector(${JSON.stringify(rowSel)}).click() })()`)
    await b.poll(async () => (await pathOf(b)) === '/tms/shipments/new', 'route /tms/shipments/new', 20_000)
    await b.poll(() => has(b, tid('ship-form-intake-banner')), 'the pre-fill banner', 30_000)
    const bad = []
    const eq = async (label, id2, want) => { const got = await valOf(b, id2); if (got !== want) bad.push(`${label}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`) }
    await eq('equipment', 'f-shipping-equipmentType', 'Dry Van'); await eq('weight', 'f-shipping-weightLbs', '20000')
    await eq('pickup city', 'f-pickup-city', 'Chicago'); await eq('delivery city', 'f-consignee-city', 'Dallas')
    await eq('rate', 'f-rates-customerLhRate', '1800.00')
    const chips = await countOf(b, '[data-testid$="-from-email"]')
    if (chips < 4) bad.push(`only ${chips} "from e-mail" chips`)
    const rail = await textOf(b, 'rail-customer')
    if (!(rail ?? '').includes('ZZ AH Customer')) bad.push(`the rail customer line reads ${JSON.stringify(rail)}`)
    await shotAR(b, 'intake-prefill-1440')
    await b.navigate('/tms/shipments') // leave: a later form open must not replay this intake via history state
    failures(bad)
    return `Intake board row → Create shipment opens the new layout pre-filled (${chips} "from e-mail" chips, rate, lane, rail summary)`
  },

  async AR09(ctx) {
    const b = ctx.b
    // Board Create button as the page-tms user is AH01. Here: the walkthrough set of the brokered form top at both widths.
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await shotAR(b, 'create-empty-1440x900')
    await b.setViewport(1280, 800); await pause(300)
    await shotAR(b, 'create-empty-1280x800')
    await b.setViewport(1440, 900)
    return 'walkthrough first-screen images written'
  },
  async AR10(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    await fillRequired(ctx, b)
    // Documents on create: attach before the shipment exists; written on Create
    const file = join(tmpdir(), `zz-ar-rate-con-${ctx.ts}.pdf`)
    await writeFile(file, '%PDF-1.4\n% ZZ AR harness rate confirmation\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
    const { root } = await b.command('DOM.getDocument', { depth: 1 })
    const { nodeId } = await b.command('DOM.querySelector', { nodeId: root.nodeId, selector: `${tid('card-documents-body')} input[type="file"]` })
    if (!nodeId) throw new Error('no file input in the Documents card')
    await b.command('DOM.setFileInputFiles', { nodeId, files: [file] })
    await b.poll(() => has(b, tid('card-documents-queued-row')), 'queued document row', 15_000).catch(() => bad.push('an attached file is not listed as queued on create'))
    if (!(await has(b, tid('card-documents-draft-note')))) bad.push('no note that attachments are not kept in the browser draft')
    if (!(await has(b, tid('card-documents-checklist')))) bad.push('no Required-for-release checklist')
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('section-documents'))}).scrollIntoView({ block: 'center' })`)
    await shotAR(b, 'documents-create-1440')
    await click(b, 'ship-form-create')
    const id = await waitEditUrl(ctx, b, 'create with a queued document')
    await b.poll(async () => (await getBundle(ctx, id)).documents.length > 0, 'the queued document written on Create', 45_000).catch(() => bad.push('the queued document was not written to the shipment on Create'))
    await b.poll(() => has(b, tid('card-documents-row')), 'document row after create', 20_000).catch(() => bad.push('the document is not listed after Create'))
    failures(bad)
    return `a rate confirmation attached on create is held, then written as a ShipmentDocument on Create (${id})`
  },

  async AR11(ctx) {
    const b = ctx.b
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const bad = []
    await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
    await b.poll(() => has(b, tid('f-customer-billToBlock')), 'Bill To card', 10_000)
    for (const id of ['card-billTo-terms', 'card-billTo-limit', 'card-billTo-available', 'card-billTo-emails', 'card-billTo-factoring', 'card-billTo-requirements', 'card-billTo-status', 'card-billTo-open']) if (!(await has(b, tid(id)))) bad.push(`Bill To card lacks ${id}`)
    if ((await b.evaluate(`document.querySelector('[data-testid="ship-form-header-panel"]').hidden`)) !== true) bad.push('the Bill To panel is not collapsed by default')
    const chip = await textOf(b, 'hdr-billTo-text')
    if (!/Net \d+|Due on receipt|Terms/i.test(chip ?? '') && !/actored/i.test(chip ?? '')) bad.push(`the Bill To chip reads ${JSON.stringify(chip)}`)
    await click(b, 'hdr-billTo-chip'); await pause(200)
    if ((await b.evaluate(`document.querySelector('[data-testid="ship-form-header-panel"]').hidden`)) !== false) bad.push('the Details chevron did not open the Bill To panel')
    const editable = await b.evaluate(`document.querySelector('[data-testid="f-customer-billToBlock"]').querySelectorAll('input:not([readonly]):not([disabled]), textarea, select').length`)
    if (editable > 0) bad.push(`the Bill To detail has ${editable} editable controls`)
    for (const id of ['f-customer-contact', 'f-customer-phone', 'f-customer-email-1', 'f-customer-email-2']) if (!(await b.evaluate(`!!document.querySelector('[data-testid="ship-form-header-panel"] [data-testid="${id}"]')`))) bad.push(`the panel's Customer contact column lacks ${id}`)
    const cols = await b.evaluate(`(() => { const g = document.querySelector('[data-testid="ship-form-header-panel"] [class*="tms-card-billto-grid"]'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0 })()`)
    if (cols !== 3) bad.push(`the Bill To grid has ${cols} columns at 1440 (want 3)`)
    // Rate history: the lane, what we ran it for, DAT (stub badge while the login is missing), suggested rate
    await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
    await pickFrom(b, tid('f-consignee-name'), tid('f-consignee-name-option'), ctx.locNames.receiver)
    await fill(b, 'f-shipping-equipmentType', 'Dry Van')
    await b.poll(() => has(b, tid('card-rateHistory-ran')), 'the "what we ran it for" block', 30_000).catch(() => bad.push('no "what we ran it for" block for a lane'))
    if (!(await has(b, tid('card-rateHistory-dat')))) bad.push('no DAT RateView block')
    await b.poll(async () => !/Looking up/i.test(await b.evaluate(`document.querySelector('[data-testid="card-rateHistory-dat"]')?.innerText ?? 'Looking up'`)), 'DAT block settled', 40_000).catch(() => bad.push('the DAT block never left "Looking up DAT…"'))
    const dat = await b.evaluate(`document.querySelector('[data-testid="card-rateHistory-dat"]')?.innerText ?? ''`)
    if (!/not connected/i.test(dat)) bad.push(`the DAT block does not say "DAT not connected" (${JSON.stringify(dat.replace(/\s+/g, ' ').slice(0, 120))})`)
    if (/\\$\\s?\\d/.test(dat) && /not connected/i.test(dat)) bad.push('the DAT block shows a dollar figure while saying DAT is not connected')
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('rail-rate-history'))}).scrollIntoView({ block: 'start' })`)
    await shotAR(b, 'rate-history-1440')
    await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
    await shotAR(b, 'bill-to-1440')
    failures(bad)
    return `Bill To chip + collapsed-by-default panel (read-only detail, 3-column grid, Customer contact column), status / terms / credit / e-mails / requirements / Open customer; Rate history shows the lane blocks (DAT: ${JSON.stringify(dat.replace(/\\s+/g, ' ').slice(0, 80))})`
  },

  async AR12(ctx) {
    const b = ctx.b
    const id = ctx.ivanId ?? ctx.fullId
    expect(id, 'no ZZ shipment from AR06 / AH12 to read the Activity block from')
    await b.setViewport(1440, 900)
    const bad = []

    // Create: Draft chip only, empty-state line, block order, exactly three roles, Shipment type first in Freight.
    await openForm(b, '/tms/shipments/new')
    if ((await textOf(b, 'rail-stage-chip')) !== 'Draft, not created yet') bad.push(`create stage chip reads ${JSON.stringify(await textOf(b, 'rail-stage-chip'))}`)
    if ((await b.evaluate(`document.querySelector('[data-testid="rail-step-DRAFT"]')?.getAttribute('data-state')`)) !== 'current') bad.push('the stepper is not at Draft on create')
    if (!/Activity starts when the shipment is created/.test((await textOf(b, 'rail-activity-empty')) ?? '')) bad.push('create mode lacks "Activity starts when the shipment is created"')
    const order = await b.evaluate(`[...document.querySelectorAll('[data-testid="rail-required"], [data-testid="rail-activity"], [data-testid="rail-roles"]')].map((n) => n.dataset.testid).join()`)
    if (order !== 'rail-required,rail-activity,rail-roles') bad.push(`rail block order ${order}`)
    const roles = await b.evaluate(`[...document.querySelectorAll('[data-testid="rail-roles"] [data-testid^="f-roles-"]')].map((n) => n.dataset.testid).join()`)
    if (roles !== 'f-roles-salesRepId,f-roles-serviceRepId,f-roles-dispatcherAssignedId') bad.push(`Roles shows ${roles}`)
    for (const gone of ['f-roles-tariff', 'f-roles-quoteId', 'f-roles-dispatcherActual']) if (await has(b, tid(gone))) bad.push(`${gone} is still on the form`)
    const typeOpts = await b.evaluate(`[...(document.querySelector('[data-testid="f-shipping-shipmentType"]')?.options ?? [])].map((o) => o.textContent)`)
    if (typeOpts.length < 25) bad.push(`Shipment type offers ${typeOpts.length} types (want 25)`)
    await shotAR(b, 'create-rail-activity-1440')

    // Edit an existing ZZ shipment: stage chip, save, activity row with the actor's display name and a field detail.
    await openForm(b, `/tms/shipments/${id}/edit`)
    await b.poll(async () => /\S/.test((await textOf(b, 'rail-stage-chip')) ?? '') && (await textOf(b, 'rail-stage-chip')) !== 'Draft, not created yet', 'stage chip on an existing shipment', 15_000)
    const labels = ['Draft', 'Intake review', 'Active', 'Covered', 'In transit', 'Delivered', 'Load Review', 'Billed', 'Paid', 'Voided', 'Canceled']
    const chip = await textOf(b, 'rail-stage-chip')
    if (!labels.includes(chip)) bad.push(`stage chip ${JSON.stringify(chip)} is not on the ladder`)
    const stamp = `ZZ AR activity ${ctx.ts}`
    await fill(b, 'f-shipping-description', stamp)
    if (await b.evaluate(`!document.querySelector('[data-testid="f-shipping-shipmentType"]')?.disabled`)) await setValue(b, tid('f-shipping-shipmentType'), 'HOT_SHOT')
    await click(b, 'ship-form-save')
    await b.poll(async () => (await b.evaluate(`document.querySelectorAll('[data-testid="rail-activity-row"]').length`)) > 0 || await has(b, tid('ship-form-issues')), 'activity rows after a save', 45_000)
    if (await has(b, tid('ship-form-issues'))) bad.push('the save was blocked, so no activity could be written')
    const rows = await b.evaluate(`[...document.querySelectorAll('[data-testid="rail-activity-row"]')].map((r) => ({ text: r.innerText.replace(/\\s+/g, ' '), actor: r.querySelector('[data-testid="rail-activity-actor"]')?.innerText ?? '', detail: r.querySelector('[data-testid="rail-activity-detail"]')?.innerText ?? '' }))`)
    if (rows.length === 0) bad.push('no Activity rows after a save')
    else {
      const first = rows[0]
      if (!first.actor || /@/.test(first.actor) || first.actor === 'Unknown user') bad.push(`newest row actor ${JSON.stringify(first.actor)} is not a display name`)
      if (!/just now|\d+m ago/.test(first.text)) bad.push(`newest row is not recent: ${JSON.stringify(first.text)}`)
      if (!rows.some((r) => /: /.test(r.detail))) bad.push(`no Activity row has a "field: value" detail: ${JSON.stringify(rows.slice(0, 3).map((r) => r.text))}`)
      if (rows.length > 5 && !(await has(b, tid('rail-activity-more')))) bad.push('more than five rows with no Show more')
    }
    if (rows.some((r) => /token|secret|password/i.test(r.text))) bad.push('an Activity row shows a secret-looking field')
    const bundle = await getBundle(ctx, id)
    const sr = bundle.orders?.[0]?.specialRequirements
    const form = (typeof sr === 'string' ? JSON.parse(sr) : sr)?.form
    if (form && form.shipmentType === undefined) bad.push('the order has no specialRequirements.form.shipmentType after a save')
    await shotAR(b, 'edit-rail-activity-1440')

    // Full history link: filtered to this shipment.
    const href = await b.evaluate(`document.querySelector('[data-testid="rail-activity-history"]')?.getAttribute('href') ?? ''`)
    if (!href.endsWith(`/tms/brokerage/audit?entity=${id}`)) bad.push(`Full history href ${href}`)
    await click(b, 'rail-activity-history')
    await b.poll(async () => (await b.evaluate(`document.querySelector('[aria-label="Entity lookup"]')?.value ?? ''`)) === id, 'the audit page filtered to the shipment', 20_000)
      .catch(() => bad.push('Full history did not open the audit page filtered to this shipment'))
    failures(bad)
    return `create: Draft not created yet, Activity placeholder, Required > Activity > Roles, Roles = Sales / Service / Dispatcher Assigned, Shipment type first with ${typeOpts.length} types; edit ${id}: stage ${JSON.stringify(chip)}, ${rows.length} activity rows after a save (actor ${JSON.stringify(rows[0]?.actor)}), Full history filters the audit page`
  },

  async AR13(ctx) {
    expect(ctx.fullId, 'AH09 did not create a shipment')
    const b = ctx.b
    const bad = []
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const cards = await b.evaluate(`[...document.querySelectorAll('.tms-ship-card')].map((c) => c.dataset.testid.replace('section-', '')).join()`)
    if (cards !== 'freight,route,rates,carrier,documents') bad.push(`cards ${cards}`)
    const railOrder = await b.evaluate(`[...document.querySelectorAll('[data-testid="rail-money"], [data-testid="rail-rate-history"], [data-testid="rail-required"], [data-testid="rail-activity"], [data-testid="rail-roles"]')].map((n) => n.dataset.testid).join()`)
    if (railOrder !== 'rail-money,rail-rate-history,rail-required,rail-activity,rail-roles') bad.push(`rail order ${railOrder}`)
    if ((await b.evaluate(`document.querySelector('[data-testid="section-carrier"] .tms-ship-card-title')?.textContent ?? ''`)) !== 'Carrier & Tracking') bad.push('the carrier card is not titled "Carrier & Tracking"')
    if (await has(b, tid('section-tracking'))) bad.push('a separate Tracking card is still on the page')

    // Edit a shipment with a carrier (AH14 covered it): the control is live; confirm one mode through the UI.
    await openForm(b, `/tms/shipments/${ctx.fullId}/edit`)
    await b.poll(() => has(b, tid('tracking-mode-control')), 'tracking mode control', 15_000)
    // The ZZ shipment has no booked carrier (booking is out of scope for this harness): the control must be read-only with the booking sentence.
    if ((await b.evaluate(`document.querySelector('[data-testid="tracking-mode-control"]').dataset.disabled`)) !== 'true') bad.push('the control is editable before a carrier is booked')
    if (!/Tracking is chosen when the carrier is booked/i.test((await textOf(b, 'card-tracking-body')) ?? '')) bad.push('no "Tracking is chosen when the carrier is booked" sentence')
    if (await has(b, tid('tracking-not-set'))) bad.push('the amber chip shows with no carrier booked')
    await shotAR(b, 'carrier-and-tracking-1440')
    failures(bad)
    return '6 cards (Carrier & Tracking merged, no Tracking card); create shows no control; an uncovered shipment shows the control read-only with the booking sentence and no amber chip (confirming needs a booked carrier: covered by unit tests)'
  },

  async AR14(ctx) {
    const id = ctx.fullId ?? ctx.ivanId
    expect(id, 'no ZZ shipment to measure')
    const b = ctx.b
    const bad = []
    // Measures every .tms-fg grid: label height, 32 px inputs sharing a row top, nothing under an input
    // except the notes counters, spans (data-span) that sum to 12 per row, no horizontal overflow.
    const MEASURE = `(() => {
      const r = (el) => el.getBoundingClientRect();
      const out = { grids: 0, fields: 0, problems: [], overflow: Math.max(document.documentElement.scrollWidth - innerWidth, (document.querySelector('.tms-ship-form-scroll')?.scrollWidth ?? 0) - (document.querySelector('.tms-ship-form-scroll')?.clientWidth ?? 0)) };
      for (const grid of document.querySelectorAll('.tms-fg')) {
        if (!grid.getClientRects().length) continue;
        out.grids += 1;
        const fields = [...grid.children].filter((c) => c.classList.contains('tms-fg-field') && c.getClientRects().length);
        // rows by top
        const rows = [];
        for (const f of fields) { const top = Math.round(r(f).top); let row = rows.find((x) => Math.abs(x.top - top) < 3); if (!row) { row = { top, fields: [] }; rows.push(row) } row.fields.push(f) }
        const gr = r(grid);
        for (const row of rows) {
          const where = row.fields.map((f) => f.querySelector('.tms-fg-label-text')?.textContent ?? '?').join('|');
          const labels = row.fields.map((f) => Math.round(r(f.querySelector('.tms-fg-label')).height));
          if (new Set(labels).size > 1) out.problems.push('label heights differ in row ' + where);
          const controls = row.fields.map((f) => f.querySelector('.tms-fg-control input:not([type=checkbox]):not([type=radio]):not([type=file]), .tms-fg-control select')).filter(Boolean);
          const tops = controls.map((c) => Math.round(r(c).top));
          if (new Set(tops).size > 1) out.problems.push('inputs do not share a top in row ' + where + ' ' + tops.join(','));
          for (const c of controls) { const h = Math.round(r(c).height); if (h !== 32) out.problems.push('input height ' + h + ' in row ' + where) }
          const left = Math.min(...row.fields.map((f) => r(f).left)), right = Math.max(...row.fields.map((f) => r(f).right));
          const spans = row.fields.map((f) => Number(f.dataset.span));
          const narrowLayout = grid.closest('.tms-ship-card, .tms-ship-hdr-panel') && r(grid.closest('.tms-ship-card, .tms-ship-hdr-panel')).width < 760;
          if (!narrowLayout && spans.reduce((a, c) => a + c, 0) !== 12 && row.fields.length > 0 && !grid.className.includes('tms-card-lane-miles')) out.problems.push('row spans ' + spans.join('+') + ' != 12 in ' + where);
          if (fields.length > 1 && (Math.abs(left - gr.left) > 2 || Math.abs(right - gr.right) > 2)) out.problems.push('row not flush (' + Math.round(left - gr.left) + ',' + Math.round(gr.right - right) + ') in ' + where);
        }
        for (const f of fields) {
          out.fields += 1;
          const control = f.querySelector('.tms-fg-control');
          const under = [...f.children].slice(2).filter((c) => !c.classList.contains('tms-fg-sr') && !c.classList.contains('tms-fg-counter'));
          if (under.length) out.problems.push('element under the input of ' + (f.querySelector('.tms-fg-label-text')?.textContent ?? '?'));
          if (/[(]/.test(f.querySelector('.tms-fg-label-text')?.textContent ?? '')) out.problems.push('parenthetical in a label');
          void control;
        }
      }
      return out;
    })()`
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      await b.setViewport(width, height)
      await openForm(b, `/tms/shipments/${id}/edit`)
      await b.poll(() => has(b, tid('delivery-timeline')), 'delivery timeline', 20_000)
      // open the Bill To panel so its grid is measured too
      await click(b, 'hdr-billTo-chip'); await pause(300)
      const m = await b.evaluate(MEASURE)
      if (m.overflow > 1) bad.push(`${width}: horizontal overflow ${m.overflow}px`)
      for (const p of m.problems.slice(0, 6)) bad.push(`${width}: ${p}`)
      if (m.fields < 20) bad.push(`${width}: only ${m.fields} fields measured`)
      const phase = await b.evaluate(`(() => { const t = document.querySelector('[data-testid="delivery-timeline"]'); const s = document.querySelector('[data-testid="delivery-timeline-svg"]'); return t ? { phase: t.dataset.phase, label: s?.getAttribute('aria-label') ?? '', top: Math.round(t.getBoundingClientRect().top), right: Math.round(innerWidth - t.getBoundingClientRect().right), h: Math.round(t.getBoundingClientRect().height) } : null })()`)
      if (!phase || !phase.label) bad.push(`${width}: delivery timeline missing or has no text summary`)
      else if (phase.h > 56) bad.push(`${width}: the timeline is ${phase.h}px tall (fixed strip height expected)`)
      await click(b, 'hdr-billTo-chip'); await pause(200)
      await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
      await shotAR(b, `edit-grid-${width}`)
      for (const key of ['freight', 'route', 'rates', 'carrier']) {
        await b.evaluate(`document.querySelector(${JSON.stringify(tid(`section-${key}`))})?.scrollIntoView({ block: 'start' })`); await pause(250)
        await shotAR(b, `grid-${key}-${width}`)
      }
    }
    // Freight rows at 1440 exactly: 3+3+3+3 / 3+3+3+3 / 9+3
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    const rows = await b.evaluate(`[...document.querySelectorAll('[data-testid="section-freight-body"] > .tms-fg > .tms-fg-field')].map((f) => f.dataset.span).join()`)
    if (rows !== '3,3,3,3,3,3,3,3,12') bad.push(`Freight spans ${rows}`)
    if (await has(b, '[data-testid="f-freight-' + 'customerRef"]')) bad.push('Customer ref is still in the Freight card')
    const hdr = await b.evaluate(`(() => { const ids = ['f-customer-name-input', 'f-customer-refNo', 'hdr-billTo-chip']; return ids.map((i) => { const el = document.querySelector('[data-testid="' + i + '"]'); return el ? Math.round(el.getBoundingClientRect().left) : null }) })()`)
    if (hdr.some((x) => x === null) || !(hdr[0] < hdr[1] && hdr[1] < hdr[2])) bad.push(`header order Customer, Customer ref, Bill To broken: ${hdr.join(',')}`)
    if (!(await b.evaluate(`document.querySelector('[data-testid="delivery-caption"]')?.innerText === 'DRAFT' || document.querySelector('[data-testid="delivery-caption"]')?.textContent === 'Draft'`))) bad.push('create: the timeline caption is not Draft')
    await shotAR(b, 'create-grid-1440')
    await shotAR(b, 'delivery-timeline-1440')
    failures(bad)
    return 'every .tms-fg grid at 1440 and 1280: label height equal, inputs 32 px sharing a row top, nothing under an input but notes counters, spans sum to 12, rows flush, no horizontal overflow; Freight spans 3,3,3,3 / 3,3,3,3 / 9,3; header order Customer > Customer ref > Bill To; delivery timeline present with a text summary; screenshots ar-*-grid-*.png'
  },

  async AR15(ctx) {
    const b = ctx.b
    const bad = []
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
    await pickFrom(b, tid('f-consignee-name'), tid('f-consignee-name-option'), ctx.locNames.receiver)
    const read = () => b.evaluate(`Number(document.querySelector('[data-testid="f-shipping-customerMiles"]')?.value ?? 0)`)
    await b.poll(async () => (await read()) > 0, 'two-stop miles', 30_000)
    const direct = await read()
    // Insert a middle pickup at a ZZ location off the Chicago-Dallas line (Waco): 3 stops = 2 legs, summed. Joliet lies on the line, so its detour can round to the same miles.
    await click(b, 'f-route-addPickup-1')
    await b.poll(() => has(b, tid('f-stop-1-name')), 'inserted pick field', 10_000)
    await pickFrom(b, tid('f-stop-1-name'), tid('f-stop-1-name-option'), ctx.locNames.stop2)
    await b.poll(async () => (await read()) !== direct, 'three-stop miles', 30_000).catch(() => bad.push('adding a middle stop did not re-measure the miles'))
    const three = await read()
    await b.evaluate(`document.querySelector('[data-testid="f-route-lane"]')?.scrollIntoView({ block: 'start' })`); await pause(400)
    await shotAR(b, 'three-stop-miles-1440')
    if (!(three >= direct)) bad.push(`three-stop miles ${three} < the two-stop ${direct} (legs must add up, not shrink)`)
    if (await has(b, '[data-testid="f-shipping-' + 'truckMiles"]')) bad.push('a Truck Miles field is still on the form')
    await fillRequired(ctx, b)
    await click(b, 'ship-form-save-draft')
    const id = await waitEditUrl(ctx, b, 'AR15 draft')
    const bundle = await getBundle(ctx, id)
    const form = (typeof bundle.orders?.[0]?.specialRequirements === 'string' ? JSON.parse(bundle.orders[0].specialRequirements) : bundle.orders?.[0]?.specialRequirements)?.form
    if (bundle.loads?.[0]?.miles !== three) bad.push(`load.miles ${bundle.loads?.[0]?.miles} ≠ ${three}`)
    if (form?.ship?.truckMiles !== three) bad.push(`form.ship.truckMiles ${form?.ship?.truckMiles} ≠ ${three}`)
    failures(bad)
    return `one Miles field: 2 stops ${direct} mi, 3 stops ${three} mi (two legs summed); the draft saved ${three} to both the load miles and form.ship.truckMiles`
  },

  async AR16(ctx) {
    const b = ctx.b
    const bad = []
    const name = `ZZ AR Dock ${ctx.ts}`
    const notes = []
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    await setValue(b, tid('f-pickup-name'), name)
    await b.poll(() => has(b, tid('f-pickup-addRow')), 'the + Add row', 15_000)
    await click(b, 'f-pickup-addRow')
    await fill(b, 'f-pickup-new-street', '1 ZZ Test Way'); await fill(b, 'f-pickup-new-zip', '60431')
    await shotAR(b, 'inline-add-location-1440')
    // Zip autofill needs the geocoder; when dev's key does not answer, type the city and state so the rest still runs.
    await b.poll(async () => (await valOf(b, 'f-pickup-new-city')) !== '', 'zip autofill', 12_000).catch(async () => { notes.push('zip autofill did not answer'); await fill(b, 'f-pickup-new-city', 'Joliet'); await fill(b, 'f-pickup-new-state', 'IL') })
    await click(b, 'f-pickup-new-save')
    await b.poll(async () => (await valOf(b, 'f-pickup-name')) === name && !(await has(b, tid('f-pickup-newLocation'))), 'the new location selected', 30_000).catch(() => bad.push('Save location did not select the new location'))
    const rows = (await listAll(ctx.token, 'Location', { name: { eq: name } }, 'id updatedAt'))
    for (const r of rows) ctx.locationIds.push(r.id)
    if (rows.length !== 1) bad.push(`${rows.length} Location rows named ${name}`)
    // Reuse on the consignee stop of the same form: it is offered at once.
    await setValue(b, tid('f-consignee-name'), name)
    await b.poll(() => has(b, tid('f-consignee-name-option')), 'the saved location offered on another stop', 15_000).catch(() => bad.push('the new location is not offered on another stop'))
    failures(bad)
    return `typed ${JSON.stringify(name)} -> "+ Add as a new location" -> zip auto-fill -> Save location created 1 directory row, selected it, and offered it on the consignee stop (archived in cleanup)${notes.length ? `; ${notes.join('; ')}` : ''}`
  },

  async AR17(ctx) {
    const b = ctx.b
    const bad = []
    // One unique token: the picker also lists near names (the fixture "ZZ AH Customer <ts>" shares 3 of 4 words with "ZZ AR Customer <ts>"), which would hide the + Add row.
    const name = `ZZ ARNewCo${ctx.ts}`
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    if (await has(b, '[data-testid="f-customer-' + 'useTyped"]')) bad.push('the typed-name checkbox is still on the form')
    await setValue(b, `${tid('f-customer-name')} input`, name)
    await b.poll(() => has(b, tid('f-customer-addRow')), 'the + Add customer row', 15_000)
    await click(b, 'f-customer-addRow')
    await b.poll(() => has(b, '[role="dialog"]'), 'the create dialog', 10_000)
    const clicked = await b.evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); const btn = [...d.querySelectorAll('button')].find((x) => /^(save|create|add)/i.test(x.innerText.trim())); if (!btn) return false; btn.click(); return true })()`)
    if (!clicked) bad.push('no Save button in the customer dialog')
    await b.poll(async () => (await b.evaluate(`document.querySelector('[data-testid="f-customer-name-input"]')?.value ?? ''`)) === name, 'the new customer selected in the header', 30_000).catch(() => bad.push('the created customer was not selected'))
    // The header input still shows the typed text while the save runs, so the poll above can pass at once: wait for the dialog to close and the row to exist.
    await b.poll(async () => !(await has(b, '[role="dialog"]')), 'the create dialog closing', 30_000).catch(() => bad.push('the create dialog did not close after Save'))
    let rows = []
    for (let i = 0; i < 15 && rows.length === 0; i++) { rows = await listAll(ctx.token, 'Customer', { name: { eq: name } }, 'id updatedAt'); if (rows.length === 0) await pause(1000) }
    for (const r of rows) { ctx.extraCustomers = [...(ctx.extraCustomers ?? []), r] }
    if (rows.length !== 1) bad.push(`${rows.length} Customer rows named ${name}`)
    failures(bad)
    return `unknown customer ${JSON.stringify(name)} -> "+ Add as a new customer" -> the directory dialog created 1 row and the header selected it (archived in cleanup)`
  },

  async AR18(ctx) {
    const b = ctx.b
    const bad = []
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      await b.setViewport(width, height)
      await openForm(b, '/tms/shipments/new')
      await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, ctx.customerName)
      await pause(400)
      await b.evaluate(`document.querySelector('.tms-ship-form-scroll')?.scrollTo(0, 0)`)
      const r = (id) => rectOf(b, tid(id))
      const bar = await r('ship-form-actionbar'); const create = await r('ship-form-create')
      if (!bar || bar.bottom > height + 1 || bar.top < 0) bad.push(`${width}: the action bar is not on screen at load (${JSON.stringify(bar)})`)
      if (!bar || bar.bottom > height + 1 || bar.height < 44 || bar.height > 64) bad.push(`${width}: the action bar is not 48 px at the foot (${JSON.stringify(bar)})`)
      if (!create || create.bottom > height || create.top < bar.top - 1) bad.push(`${width}: Create is not inside the visible bar`)
      for (const id of ['ship-form-status', 'ship-form-savestate', 'ship-form-required', 'ship-form-cancel', 'ship-form-save-draft']) if (!(await has(b, tid(id)))) bad.push(`${width}: the bar lacks ${id}`)
      if (await has(b, '[data-testid="rail-' + 'actions"]')) bad.push(`${width}: the rail still has an actions footer`)
      // Scroll to the very bottom: the bar must not overlap the last card field nor the rail's Roles block.
      await b.evaluate(`(() => { const s = document.querySelector('.tms-ship-form-scroll'); s.scrollTo(0, s.scrollHeight); for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTo(0, el.scrollHeight); window.scrollTo(0, document.documentElement.scrollHeight) })()`); await pause(300)
      const bar2 = await r('ship-form-actionbar')
      const overlap = await b.evaluate(`(() => { const bar = document.querySelector('[data-testid="ship-form-actionbar"]').getBoundingClientRect(); const hits = []; for (const sel of ['[data-testid="rail-roles"]', '[data-testid="section-documents"]', '[data-testid="ship-form-more"]']) { const el = document.querySelector(sel); if (!el || !el.getClientRects().length) continue; const q = el.getBoundingClientRect(); if (q.bottom > bar.top + 1 && q.top < bar.bottom - 1 && q.top >= 0) hits.push(sel) } return hits })()`)
      if (overlap.length) bad.push(`${width}: the bar overlaps ${overlap.join(', ')} at the bottom of the page`)
      if (!bar2 || bar2.bottom > height + 1) bad.push(`${width}: the bar left the screen when scrolled to the bottom`)
      await shotAR(b, `action-bar-${width}`)
    }
    failures(bad)
    return 'at 1440x900 and 1280x800 the 48 px action bar is visible without scrolling and at the bottom of the page, holds status / save state / required count / Cancel / Save draft / Create, overlaps neither Roles nor the last card, and the rail has no actions footer'
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
  const places = [['shipper', 'Chicago', 'IL', '60601', 41.88, -87.63], ['receiver', 'Dallas', 'TX', '75201', 32.78, -96.8], ['pick2', 'Joliet', 'IL', '60431', 41.52, -88.08], ['stop2', 'Waco', 'TX', '76701', 31.55, -97.15]]
  for (const [key, city, state, zip, lat, lng] of places) {
    const loc = await ctx.dir('UPSERT_LOCATION', { name: ctx.locNames[key], street: `${String(ts).slice(-6)} ZZ Test Way`, city, state, zip, country: 'US' })
    const id = String((loc.location ?? loc).id)
    ctx.locationIds.push(id)
    // Coordinates normally come from a signed geocode token the harness cannot mint: set them on this run's own ZZ row
    // so the stop carries geo and Customer Miles can be measured (Distance Matrix, else the labelled estimate).
    if (ctx.suffix) {
      await doc.send(new UpdateCommand({ TableName: devTable('Location', ctx.suffix), Key: { id }, ConditionExpression: 'begins_with(#n, :zz)', UpdateExpression: 'SET lat = :lat, lng = :lng, geocodeExpiresAt = :exp, geocodedAt = :now', ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':zz': 'ZZ AH ', ':lat': lat, ':lng': lng, ':exp': new Date(Date.now() + 29 * 86_400_000).toISOString(), ':now': new Date().toISOString() } }))
    }
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
  if (ctx.suffix) {
    ctx.driverId = `zz-ah-driver-${ts}`; ctx.driverName = `ZZ AH Driver ${String(ts).slice(-6)}`
    const nowIso = new Date().toISOString()
    await doc.send(new PutCommand({ TableName: devTable('Driver', ctx.suffix), Item: {
      __typename: 'Driver', id: ctx.driverId, name: ctx.driverName, active: true, type: 'driver', phone: '5550142', email: `zz-ah-driver-${ts}@example.invalid`, createdAt: nowIso, updatedAt: nowIso,
    } }))
  }
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
  if (ctx.intakeId && ctx.suffix) {
    await doc.send(new DeleteCommand({ TableName: devTable('IntakeLoad', ctx.suffix), Key: { id: ctx.intakeId } })).then(() => say(`intake row ${ctx.intakeId} deleted`), (err) => say(`intake row delete failed: ${short(err).slice(0, 80)}`, false))
  }
  if (ctx.intakeBoardId && ctx.suffix) {
    await doc.send(new DeleteCommand({ TableName: devTable('IntakeLoad', ctx.suffix), Key: { id: ctx.intakeBoardId } })).then(() => say(`intake row ${ctx.intakeBoardId} deleted`), (err) => say(`intake row delete failed: ${short(err).slice(0, 80)}`, false))
  }
  if (ctx.driverId && ctx.suffix) {
    await doc.send(new DeleteCommand({ TableName: devTable('Driver', ctx.suffix), Key: { id: ctx.driverId } })).then(() => say(`roster driver ${ctx.driverId} deleted`), (err) => say(`roster driver delete failed: ${short(err).slice(0, 80)}`, false))
  }
  if (ctx.carrierId) {
    const row = await getRow(ctx.token, 'Carrier', ctx.carrierId, 'id updatedAt status').catch(() => null)
    if (row) await ctx.car('SET_CARRIER_STATUS', { id: ctx.carrierId, expectedUpdatedAt: String(row.updatedAt), status: 'INACTIVE', reason: 'INACTIVE_AGREEMENT' }).then(() => say(`carrier ${ctx.carrierId} set INACTIVE`), (err) => say(`carrier retire failed: ${short(err).slice(0, 80)}`, false))
  }
  for (const id of ctx.locationIds) {
    const row = await getRow(ctx.token, 'Location', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_LOCATION', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`location ${id} archived`), (err) => say(`location archive failed: ${short(err).slice(0, 80)}`, false))
  }
  for (const r of ctx.extraCustomers ?? []) {
    await ctx.dir('ARCHIVE_CUSTOMER', { id: r.id, expectedUpdatedAt: String(r.updatedAt) }).then(() => say(`customer ${r.id} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
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
  await mkdir(SHOTS2, { recursive: true })
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
    ctx.suffix = await discoverDevSuffix().catch(() => null)
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
  await writeFile(join(SHOTS2, 'index.txt'), `${written.filter((f) => f.includes('/ah2/')).map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAH failed: ${err?.message ?? err}`); process.exit(1) })
}
