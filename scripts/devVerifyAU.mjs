#!/usr/bin/env node
/**
 * Step AU verification against the DEV site: the Documents card "Generate" row (Generate BOL, Rate Con, Send Info),
 * BolDialog (scope, include rates, language, preview, Generate, Download, E-mail), the BOL checklist row and the
 * stale-BOL chip (AU-plan §9).
 *
 *   node scripts/devVerifyAU.mjs [--inventory] [--only=<substring>]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAU.mjs
 *
 *   --inventory  no network, no browser: every data-testid a step selects exists in the source.
 *
 * RUNS ONLY AFTER THE DEPLOY (SAVE_GENERATED_DOCUMENT slots, BOL on a DRAFT, EMAIL_BOL). Dev only: refuses any AppSync
 * endpoint but the dev one, any staff pool but the dev pool and any origin outside ALLOWED_ORIGINS. No SSM writes, no
 * main / production. One throwaway ADMIN identity (zz-au-admin-<ts>) is created and deleted in `finally`; passwords and
 * tokens are never printed. The ONLY e-mail address ever typed or sent to is ai4bcat@gmail.com (dev SES allow-list).
 *
 * Everything it creates is ZZ AU …: two customers (A requires "Signed BOL", B requires nothing), one carrier, locations.
 * In `finally` every generated document is VOIDED, every shipment of the ZZ customers is VOIDED (never deleted: PROs are
 * permanent), customers/locations are archived, the carrier is set INACTIVE. Output carries ids and counts only.
 *
 * Not covered here (needs fixtures the form cannot set from this script): an INTERNAL-visibility reference and Items
 * hazmat lines are not typed; the PDF read-back asserts what the form does set (PRO, PO, chips, seal when booked).
 * Screenshots: Docs/tms-build/screenshots/au/<nn>-<slug>-L.png at 1440 and 1280.
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const SHOTS = resolve('Docs/tms-build/screenshots/au')
const VOID_REASON = 'AU harness'
const MAILBOX = 'ai4bcat@gmail.com'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: [], skipAllowed: {}, only })
const { line, report, written, waitLoaded, matches } = walk

export const AU_STEPS = [
  { id: 'AU01', slug: 'generate-row-states' },
  { id: 'AU02', slug: 'dialog-preview-and-text' },
  { id: 'AU03', slug: 'generate-and-checklist' },
  { id: 'AU04', slug: 'regenerate-supersedes' },
  { id: 'AU05', slug: 'per-stop-slots' },
  { id: 'AU06', slug: 'download-bytes' },
  { id: 'AU07', slug: 'rated-copy' },
  { id: 'AU08', slug: 'email-bol' },
  { id: 'AU09', slug: 'rate-con-send-info-buttons' },
  { id: 'AU10', slug: 'stale-chip' },
]

const tid = (id) => `[data-testid="${id}"]`
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const failures = (list) => { if (list.length) throw new Error(list.slice(0, 4).join(' | ')) }

/** Every literal data-testid the steps select; --inventory proves each one exists in the source. */
const FORM_IDS = [
  'ship-form', 'ship-form-create', 'ship-form-save', 'card-documents-generate', 'card-documents-generate-bol',
  'card-documents-generate-ratecon', 'card-documents-generate-info', 'card-documents-generate-hint',
  'card-documents-check-', 'card-documents-check-generated', 'card-documents-bol-stale',
  'card-documents-show-superseded', 'card-documents-superseded-chip', 'card-documents-row',
]
const DIALOG_IDS = [
  'bol-dialog', 'bol-scope', 'bol-include-rates', 'bol-language', 'bol-preview', 'bol-generate', 'bol-download',
  'bol-email-toggle', 'bol-email-panel', 'bol-email-send', 'bol-customer-copy-note', 'bol-close', 'bol-filename',
]

async function sourceText(dir) {
  let text = ''
  for (const entry of await readdir(resolve(dir), { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) text += await sourceText(full)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) text += await readFile(resolve(full), 'utf8')
  }
  return text
}

export async function inventory() {
  const haystack = await sourceText('src/features/shipments')
  const labels = await readFile(resolve('src/features/shipments/form/labels.ts'), 'utf8')
  const missing = [...FORM_IDS, ...DIALOG_IDS].filter((id) => !haystack.includes(id))
  if (missing.length) { line('FAIL', 'gate 1: every data-testid a step selects exists', missing.join(', ')); return false }
  if (!/generateBol/.test(labels)) { line('FAIL', 'gate 1: LABEL.documents.generateBol exists'); return false }
  line('PASS', 'gate 1: every data-testid a step selects exists', `${FORM_IDS.length + DIALOG_IDS.length} ids`)
  return true
}

// ───────────────────────────── browser helpers ─────────────────────────────
const bodyText = (b) => b.evaluate('document.body.innerText')
const pathOf = (b) => b.evaluate('location.pathname')
const has = (b, selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
const textOf = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.innerText ?? null`)
const isDisabled = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.disabled ?? 'missing'`)
const titleOf = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.title ?? null`)

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
async function clickSel(b, selector) {
  const hit = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'no-element'; if (el.disabled) return 'disabled'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok' })()`)
  if (hit !== 'ok') throw new Error(`click ${selector}: ${hit}`)
}
const click = (b, id) => clickSel(b, tid(id))

async function selectFirst(b, id) {
  const value = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(tid(id))}); return el ? ([...el.options].find((o) => o.value && !o.disabled)?.value ?? null) : null })()`)
  if (!value) throw new Error(`select ${id}: no real option`)
  await fill(b, id, value)
}

async function pickFrom(b, inputSelector, optionSelector, text) {
  await setValue(b, inputSelector, text)
  await b.poll(() => has(b, optionSelector), `suggestion for ${optionSelector}`, 40_000)
  const hit = await b.evaluate(`(() => { const o = [...document.querySelectorAll(${JSON.stringify(optionSelector)})]; const el = o.find((n) => n.textContent.includes(${JSON.stringify(text)})) ?? o[0]; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`)
  if (!hit) throw new Error(`click ${optionSelector}: no-element`)
  await pause(300)
}
const CUSTOMER_OPTION = `${tid('f-customer-name')} li button:not([data-testid="f-customer-addRow"])`

const localDt = (dayOffset, hh) => {
  const d = new Date(Date.now() + dayOffset * 86_400_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:00`
}

async function openForm(b, path) {
  await b.navigate(path)
  await b.poll(() => has(b, tid('ship-form')), `${path} form`, 60_000)
  await pause(800)
}

async function shot(b, name) {
  const file = join(SHOTS, `${name}-L.png`)
  await b.screenshot(file)
  written.push(file)
}

const shipmentIdFromPath = (path) => /^\/tms\/shipments\/([^/]+)\/edit$/.exec(path)?.[1] ?? null
async function waitEditUrl(ctx, b, label) {
  await b.poll(async () => shipmentIdFromPath(await pathOf(b)) !== null || await has(b, tid('ship-form-issues')), `${label}: edit URL`, 60_000)
  const id = shipmentIdFromPath(await pathOf(b))
  if (!id) throw new Error(`${label}: stayed on the form (${JSON.stringify((await bodyText(b)).replace(/\s+/g, ' ').slice(0, 260))})`)
  ctx.shipmentIds.add(id)
  return id
}

const getBundle = (ctx, shipmentId) => ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
const bols = (bundle) => bundle.documents.filter((d) => d.type === 'BOL')

async function fillRequired(ctx, b, { customerName, stops }) {
  await pickFrom(b, `${tid('f-customer-name')} input`, CUSTOMER_OPTION, customerName)
  await fill(b, 'f-shipping-equipmentType', 'Dry Van')
  await selectFirst(b, 'f-shipping-revDivision')
  await fill(b, 'f-shipping-weightLbs', '12000')
  await fill(b, 'f-shipping-description', ctx.commodity)
  await pickFrom(b, tid('f-pickup-name'), tid('f-pickup-name-option'), ctx.locNames.shipper)
  await fill(b, 'f-pickup-ready', localDt(1, 7))
  await pickFrom(b, tid('f-consignee-name'), tid('f-consignee-name-option'), ctx.locNames.receiver)
  if (stops > 1) {
    await click(b, 'f-route-addDelivery-1')
    await b.poll(() => has(b, tid('f-stop-1-name')), 'inserted delivery', 10_000)
    await pickFrom(b, tid('f-stop-1-name'), tid('f-stop-1-name-option'), ctx.locNames.stop2)
    await fill(b, 'f-stop-1-appt', localDt(2, 12))
  }
  await fill(b, 'f-pickup-refNo', ctx.refPickup)
}

async function createShipment(ctx, b, opts, label) {
  await openForm(b, '/tms/shipments/new')
  await fillRequired(ctx, b, opts)
  await click(b, 'ship-form-create')
  return waitEditUrl(ctx, b, label)
}

async function openDialog(b) {
  await click(b, 'card-documents-generate-bol')
  await b.poll(() => has(b, tid('bol-dialog')), 'BolDialog', 20_000)
  await b.poll(() => has(b, tid('bol-preview')), 'BOL preview', 60_000)
}
const closeDialog = async (b) => { await click(b, 'bol-close'); await b.poll(async () => !(await has(b, tid('bol-dialog'))), 'dialog closed', 10_000) }

/** Generate in the open dialog and wait until the stored row count of BOLs reaches `count`. */
async function generate(ctx, b, id, count) {
  await click(b, 'bol-generate')
  await b.poll(async () => bols(await getBundle(ctx, id)).length >= count, `BOL row #${count}`, 60_000)
}

/** Text of the PDF the dialog previews/downloads: capture the presigned URL the Download button opens, read it with pdftotext. */
async function downloadText(b) {
  await b.evaluate(`(() => { window.__au = []; const open = window.open; window.open = (u) => { window.__au.push(String(u)); return null };
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__au.push(this.href); return undefined }; })()`)
  await click(b, 'bol-download')
  const url = await b.poll(() => b.evaluate('window.__au?.[0] ?? null'), 'download URL', 30_000)
  const buf = await b.evaluate(`fetch(${JSON.stringify(url)}).then(async (r) => { const bytes = new Uint8Array(await r.arrayBuffer()); let s = ''; for (const x of bytes) s += String.fromCharCode(x); return { status: r.status, length: r.headers.get('content-length'), b64: btoa(s) } })`)
  expect(buf.status === 200, `download answered ${buf.status}`)
  const bytes = Buffer.from(buf.b64, 'base64')
  expect(bytes.subarray(0, 5).toString() === '%PDF-', 'download is not a PDF')
  const file = join(tmpdir(), `au-bol-${randomUUID()}.pdf`)
  await writeFile(file, bytes)
  const out = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  return { bytes: bytes.length, length: Number(buf.length), text: out.status === 0 ? out.stdout : null }
}

// ───────────────────────────── steps ─────────────────────────────
const RUNNERS = {
  async AU01(ctx) {
    const b = ctx.b
    const bad = []
    await b.setViewport(1440, 900)
    await openForm(b, '/tms/shipments/new')
    for (const id of ['bol', 'ratecon', 'info']) {
      if ((await isDisabled(b, `card-documents-generate-${id}`)) !== true) bad.push(`create mode: ${id} is not disabled`)
    }
    if (!(await titleOf(b, 'card-documents-generate-bol'))) bad.push('create mode: no reason on Generate BOL')
    await shot(b, '01-generate-row-create-1440')
    await fillRequired(ctx, b, { customerName: ctx.custA.name, stops: 2 })
    await click(b, 'ship-form-create')
    const id = await waitEditUrl(ctx, b, 'create A')
    ctx.idA = id
    const bundle = await getBundle(ctx, id)
    if (bundle.shipment.status !== 'DRAFT') bad.push(`shipment is ${bundle.shipment.status}, want DRAFT`)
    await b.poll(async () => (await isDisabled(b, 'card-documents-generate-bol')) === false, 'Generate BOL enabled on the saved DRAFT', 20_000).catch(() => bad.push('Generate BOL stayed disabled on a saved DRAFT (D5)'))
    await fill(b, 'f-shipping-description', `${ctx.commodity} edited`)
    await pause(300)
    if ((await isDisabled(b, 'card-documents-generate-bol')) !== true) bad.push('dirty form: Generate BOL still enabled')
    if ((await textOf(b, 'card-documents-generate-hint')) !== 'Save first') bad.push('dirty form: no "Save first" hint')
    await click(b, 'ship-form-save')
    await b.poll(async () => (await isDisabled(b, 'card-documents-generate-bol')) === false, 'Generate BOL enabled after Save', 30_000).catch(() => bad.push('Generate BOL did not come back after Save'))
    await shot(b, '01-generate-row-saved-1440')
    await b.setViewport(1280, 800)
    await shot(b, '01-generate-row-saved-1280')
    await b.setViewport(1440, 900)
    failures(bad)
    return `create: all three disabled with a reason; Create → DRAFT, BOL enabled; dirty → "Save first"; Save → enabled (${id})`
  },

  async AU02(ctx) {
    expect(ctx.idA, 'AU01 did not create shipment A')
    const b = ctx.b
    const bad = []
    await openForm(b, `/tms/shipments/${ctx.idA}/edit`)
    const before = await b.evaluate(`document.querySelector(${JSON.stringify(tid('card-documents-check-BOL'))})?.getAttribute('data-met') + ':' + document.querySelector(${JSON.stringify(tid('card-documents-check-BOL'))})?.getAttribute('data-required')`)
    if (before !== 'false:true') bad.push(`customer A: BOL row is ${before}, want unticked + required`)
    await openDialog(b)
    await shot(b, '02-dialog-1440')
    ctx.scopeA = await b.evaluate(`document.querySelector(${JSON.stringify(tid('bol-scope'))})?.options.length ?? 0`)
    if (ctx.scopeA < 3) bad.push(`scope list has ${ctx.scopeA} options for two deliveries`)
    for (const id of ['bol-email-toggle', 'bol-download']) if ((await isDisabled(b, id)) !== true) bad.push(`${id} enabled before Generate`)
    failures(bad)
    return `row required + unticked; dialog preview rendered; scope options ${ctx.scopeA}; Download / E-mail disabled before Generate`
  },

  async AU03(ctx) {
    const b = ctx.b
    const bad = []
    await generate(ctx, b, ctx.idA, 1)
    const bundleA = await getBundle(ctx, ctx.idA)
    ctx.proA = bundleA.shipment.number
    const [row] = bols(bundleA)
    if (row.audience !== 'ALL' || row.source !== 'GENERATED' || row.version !== 1 || !row.uploadedBy || !row.uploadedAt) bad.push(`stored row ${JSON.stringify({ audience: row.audience, source: row.source, version: row.version })}`)
    const dl = await downloadText(b)
    ctx.pdfText = dl.text
    if (dl.text) {
      if (!dl.text.includes(String(ctx.proA))) bad.push('PDF lacks the PRO')
      if (/\$\s?\d/.test(dl.text)) bad.push('the default BOL prints a dollar amount')
      for (const word of ['Shipper', 'Carrier', 'Consignee']) if (!new RegExp(word, 'i').test(dl.text)) bad.push(`PDF lacks the ${word} signature block`)
      if (!dl.text.includes(ctx.refPickup)) bad.push('PDF lacks the pickup reference')
    }
    await closeDialog(b)
    await b.poll(async () => (await b.evaluate(`document.querySelector(${JSON.stringify(tid('card-documents-check-BOL'))})?.getAttribute('data-met')`)) === 'true', 'BOL ticked after refresh', 20_000).catch(() => bad.push('checklist BOL not ticked after Generate'))
    if ((await textOf(b, 'card-documents-check-generated')) !== 'generated v1') bad.push('tick does not say "generated v1"')
    // customer B: optional before, ticked after
    const idB = await createShipment(ctx, b, { customerName: ctx.custB.name, stops: 1 }, 'create B')
    ctx.idB = idB
    const optional = await b.evaluate(`document.querySelector(${JSON.stringify(tid('card-documents-check-BOL'))})?.getAttribute('data-required')`)
    if (optional !== 'false') bad.push(`customer B: BOL data-required=${optional}, want false (optional)`)
    await openDialog(b)
    await generate(ctx, b, idB, 1)
    await closeDialog(b)
    await b.poll(async () => (await b.evaluate(`document.querySelector(${JSON.stringify(tid('card-documents-check-BOL'))})?.getAttribute('data-met')`)) === 'true', 'B ticked', 20_000).catch(() => bad.push('customer B: BOL not ticked after Generate'))
    const audit = (await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: ctx.idA })).auditLogs ?? []
    if (audit.length && !audit.some((a) => a.action === 'SAVE_GENERATED_DOCUMENT')) bad.push('no SAVE_GENERATED_DOCUMENT audit row')
    failures(bad)
    return `A: BOL ALL/GENERATED v1 by the temp identity, ticked; B: optional → ticked${dl.text ? '; PDF text read back with pdftotext' : '; pdftotext unavailable, text checks skipped'}`
  },

  async AU04(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.idA}/edit`)
    await openDialog(b)
    await generate(ctx, b, ctx.idA, 2)
    const rows = bols(await getBundle(ctx, ctx.idA)).filter((d) => !d.stopId)
    const v2 = rows.find((d) => d.version === 2)
    const v1 = rows.find((d) => d.version === 1)
    expect(v2?.status === 'ACTIVE', 'v2 is not ACTIVE')
    expect(v1?.status === 'SUPERSEDED' && v1.supersedesId == null && v2.supersedesId === v1.id, `v1 ${v1?.status}, v2.supersedesId ${v2?.supersedesId}`)
    await closeDialog(b)
    await b.poll(() => has(b, tid('card-documents-show-superseded')), 'Show superseded toggle', 20_000)
    await click(b, 'card-documents-show-superseded')
    await b.poll(() => has(b, tid('card-documents-superseded-chip')), 'superseded chip', 10_000)
    await shot(b, '04-superseded-list-1440')
    return 'regenerate → v2 ACTIVE, v1 SUPERSEDED (v2.supersedesId = v1), v1 listed under Show superseded'
  },

  async AU05(ctx) {
    const b = ctx.b
    expect(ctx.scopeA >= 3, 'shipment A has no per-stop scope options (needs 2 deliveries)')
    await openForm(b, `/tms/shipments/${ctx.idA}/edit`)
    const before = bols(await getBundle(ctx, ctx.idA)).length
    for (const index of [1, 2]) {
      await openDialog(b)
      const value = await b.evaluate(`[...document.querySelector(${JSON.stringify(tid('bol-scope'))}).options][${index}].value`)
      await fill(b, 'bol-scope', value)
      await b.poll(() => has(b, tid('bol-preview')), 'preview after scope change', 60_000)
      await pause(1500)
      await click(b, 'bol-generate')
      await b.poll(async () => bols(await getBundle(ctx, ctx.idA)).length >= before + index, `per-stop BOL ${index}`, 60_000)
      await closeDialog(b)
    }
    const stopRows = bols(await getBundle(ctx, ctx.idA)).filter((d) => d.stopId && d.status === 'ACTIVE')
    expect(new Set(stopRows.map((d) => d.stopId)).size === 2 && stopRows.every((d) => d.version === 1), `per-stop rows ${JSON.stringify(stopRows.map((d) => [d.stopId?.slice(-6), d.version]))}`)
    const master = bols(await getBundle(ctx, ctx.idA)).filter((d) => !d.stopId && d.status === 'ACTIVE')
    expect(master.length === 1 && master[0].version === 2, 'the master BOL changed when per-stop BOLs were generated')
    return 'Delivery 1 and Delivery 2 → two ACTIVE BOLs with distinct stopId (v1 each); master v2 untouched'
  },

  async AU06(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.idA}/edit`)
    await openDialog(b)
    await generate(ctx, b, ctx.idA, bols(await getBundle(ctx, ctx.idA)).length + 1)
    const dl = await downloadText(b)
    const row = bols(await getBundle(ctx, ctx.idA)).sort((x, y) => y.uploadedAt.localeCompare(x.uploadedAt))[0]
    expect(dl.bytes === row.sizeBytes, `downloaded ${dl.bytes} bytes, row sizeBytes ${row.sizeBytes}`)
    expect(dl.length === dl.bytes, `Content-Length ${dl.length} ≠ ${dl.bytes}`)
    await closeDialog(b)
    return `presigned download is a %PDF- of ${dl.bytes} bytes = row.sizeBytes = Content-Length`
  },

  async AU07(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.idA}/edit`)
    await openDialog(b)
    await fill(b, 'bol-include-rates', 'YES')
    await pause(1500)
    await b.poll(() => has(b, tid('bol-preview')), 'preview with rates', 60_000)
    const before = bols(await getBundle(ctx, ctx.idA)).filter((d) => d.audience === 'ALL' && !d.stopId && d.status === 'ACTIVE')
    await click(b, 'bol-generate')
    await b.poll(async () => bols(await getBundle(ctx, ctx.idA)).some((d) => d.audience === 'CUSTOMER'), 'rated BOL stored', 60_000)
    const after = bols(await getBundle(ctx, ctx.idA))
    expect(after.filter((d) => d.audience === 'ALL' && !d.stopId && d.status === 'ACTIVE').length === before.length, 'the rated copy superseded the plain BOL')
    expect(await has(b, tid('bol-customer-copy-note')), 'no customer-copy hint on the rated BOL')
    expect(!(await has(b, tid('bol-email-panel'))), 'the e-mail panel is still offered for a rated BOL')
    const rated = after.find((d) => d.audience === 'CUSTOMER')
    const refused = await ctx.ship('EMAIL_BOL', { shipmentId: ctx.idA, documentId: rated.id, to: [MAILBOX], party: 'CUSTOMER' }).then(() => false, () => true)
    expect(refused, 'EMAIL_BOL accepted a rated BOL')
    await closeDialog(b)
    return 'rated BOL stored audience CUSTOMER, plain chain unaffected, EMAIL_BOL refused, e-mail panel replaced by the customer-copy hint'
  },

  async AU08(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.idA}/edit`)
    await openDialog(b)
    // E-mail needs the stored row: Generate (plain, master) first.
    await click(b, 'bol-generate')
    await b.poll(() => b.evaluate(`!document.querySelector(${JSON.stringify(tid('bol-email-toggle'))})?.disabled`), 'E-mail enabled', 60_000)
    await click(b, 'bol-email-toggle')
    await b.poll(() => has(b, tid('bol-email-panel')), 'e-mail panel', 10_000)
    const preselected = await b.evaluate(`[...document.querySelectorAll(${JSON.stringify(tid('bol-email-panel'))} + ' input[type=checkbox]')].filter((c) => c.checked).length`)
    expect(preselected === 0, `${preselected} recipient(s) preselected, want none`)
    // The only address typed anywhere: the dev mailbox.
    await setValue(b, `${tid('bol-email-panel')} input[type="email"], ${tid('bol-email-panel')} input[type="text"]`, MAILBOX)
    await b.evaluate(`document.querySelector(${JSON.stringify(tid('bol-email-panel'))} + ' input[type="email"], ' + ${JSON.stringify(tid('bol-email-panel'))} + ' input[type="text"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await shot(b, '08-email-panel-1440')
    await click(b, 'bol-email-send')
    const message = await b.poll(async () => {
      const rows = await gql(ctx.token, 'query($f: ModelShipmentMessageFilterInput) { listShipmentMessages(filter: $f, limit: 100) { items { id kind direction providerRef documentIds subject } } }', { f: { shipmentId: { eq: ctx.idA } } })
      return rows.listShipmentMessages.items.find((m) => (m.documentIds ?? []).length) ?? null
    }, 'ShipmentMessage row', 60_000)
    expect(message.kind === 'OTHER' && message.direction === 'OUT' && /\[ref /.test(message.subject ?? ''), `message row ${JSON.stringify({ kind: message.kind, direction: message.direction })}`)
    return `e-mailed only to ${MAILBOX}; nothing preselected; ShipmentMessage OUT/OTHER with documentIds and [ref] subject${message.providerRef ? ' and a provider id' : ' (NOT_SENT: no provider id)'}`
  },

  async AU09(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.idB}/edit`)
    expect((await isDisabled(b, 'card-documents-generate-ratecon')) === true && (await isDisabled(b, 'card-documents-generate-info')) === true, 'Rate Con / Send Info enabled before a carrier is covered')
    expect((await titleOf(b, 'card-documents-generate-ratecon')) === 'Cover a carrier first', 'no "Cover a carrier first" reason')
    return 'Rate Con and Send Info disabled with "Cover a carrier first" (opening the existing dialogs is covered by the unit tests; nothing is sent in this run)'
  },

  async AU10(ctx) {
    const b = ctx.b
    await openForm(b, `/tms/shipments/${ctx.idB}/edit`)
    await fill(b, 'f-shipping-description', `${ctx.commodity} changed after BOL`)
    await click(b, 'ship-form-save')
    await b.poll(() => has(b, tid('card-documents-bol-stale')), 'stale-BOL chip after an edit', 30_000)
    return 'editing the saved shipment after a generated BOL shows the "predates the last edit" chip'
  },
}

// ───────────────────────────── dev helpers ─────────────────────────────
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
  const customer = async (label, requiredDocsForInvoice) => {
    const name = `ZZ AU Customer ${label} ${ts}`
    const res = await ctx.dir('UPSERT_CUSTOMER', {
      name, creditLimitCents: 100_000_000, defaultSalesRepId: repId, requiredDocsForInvoice,
      contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AU Contact', email: `ai4bcat+zz-au-${label.toLowerCase()}@gmail.com`, types: [] }],
      billToParties: [{ id: `zz-au-bt-${label}-${ts}`, name: 'ZZ AU Bill To', isDefault: true }],
    })
    return { id: String((res.customer ?? res).id), name }
  }
  ctx.custA = await customer('A', ['Signed BOL'])
  ctx.custB = await customer('B', [])
  ctx.locNames = { shipper: `ZZ AU Shipper ${ts}`, receiver: `ZZ AU Receiver ${ts}`, stop2: `ZZ AU Second Stop ${ts}` }
  for (const [key, city, state, zip] of [['shipper', 'Chicago', 'IL', '60601'], ['receiver', 'Dallas', 'TX', '75201'], ['stop2', 'Waco', 'TX', '76701']]) {
    const loc = await ctx.dir('UPSERT_LOCATION', { name: ctx.locNames[key], street: `${String(ts).slice(-6)} ZZ Test Way`, city, state, zip, country: 'US' })
    ctx.locationIds.push(String((loc.location ?? loc).id))
  }
  const n = String(ts).slice(-6)
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const carrier = await ctx.car('UPSERT_CARRIER', {
    name: `ZZ AU Carrier ${n}`, type: 'TL', status: 'ACTIVE', mcNumber: `9${n}`, dotNumber: `9${n}`, mcpStatus: 'NOT_INVITED',
    accountingEmail: `ai4bcat+zz-au-ap@gmail.com`, dispatcherEmail: `ai4bcat+zz-au-dispatch@gmail.com`,
    insurancePolicies: [
      { type: 'AUTO_LIABILITY', company: 'ZZ AU Mutual', policyNumber: `ZZAL-${ts}`, limitCents: 100000000, expiresAt: nextYear },
      { type: 'CARGO', company: 'ZZ AU Mutual', policyNumber: `ZZCG-${ts}`, limitCents: 10000000, expiresAt: nextYear },
    ],
    notes: 'ZZ AU harness carrier. Not a real carrier; safe to archive.',
  }).then((r) => r.carrier ?? r)
  ctx.carrierId = String(carrier.id)
  ctx.commodity = `ZZ AU freight ${ts}`
  ctx.refPickup = `ZZ-AU-PU-${ts}`
}

async function cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1 }
  if (!ctx.token) return
  const ids = new Set(ctx.shipmentIds)
  for (const c of [ctx.custA, ctx.custB]) {
    if (c) for (const r of await listAll(ctx.token, 'Shipment', { customerId: { eq: c.id } }, 'id').catch(() => [])) ids.add(r.id)
  }
  for (const id of ids) {
    try {
      const bundle = await getBundle(ctx, id).catch(() => null)
      for (const d of bundle?.documents ?? []) {
        if (d.status !== 'VOID') await ctx.ship('VOID_DOCUMENT', { documentId: d.id, reason: VOID_REASON }).catch((err) => say(`document ${d.id} void failed: ${short(err).slice(0, 80)}`, false))
      }
      const row = await getRow(ctx.token, 'Shipment', id, 'id updatedAt voidedAt')
      if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = await getRow(ctx.token, 'Shipment', id, 'voidedAt')
      say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
    } catch (err) { say(`shipment ${id} void failed: ${short(err).slice(0, 100)}`, false) }
  }
  if (ctx.carrierId) {
    const row = await getRow(ctx.token, 'Carrier', ctx.carrierId, 'id updatedAt').catch(() => null)
    if (row) await ctx.car('SET_CARRIER_STATUS', { id: ctx.carrierId, expectedUpdatedAt: String(row.updatedAt), status: 'INACTIVE', reason: 'INACTIVE_AGREEMENT' }).then(() => say(`carrier ${ctx.carrierId} set INACTIVE`), (err) => say(`carrier retire failed: ${short(err).slice(0, 80)}`, false))
  }
  for (const id of ctx.locationIds) {
    const row = await getRow(ctx.token, 'Location', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_LOCATION', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`location ${id} archived`), (err) => say(`location archive failed: ${short(err).slice(0, 80)}`, false))
  }
  for (const c of [ctx.custA, ctx.custB]) {
    if (!c) continue
    const row = await getRow(ctx.token, 'Customer', c.id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id: c.id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${c.id} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

async function runStep(ctx, step) {
  if (!matches(step.id)) return
  ctx.b?.mark()
  try {
    const detail = await RUNNERS[step.id](ctx)
    line('PASS', `${step.id} ${step.slug}`, typeof detail === 'string' ? detail : undefined)
  } catch (err) {
    line('FAIL', `${step.id} ${step.slug}`, short(err).slice(0, 600))
    const file = join(SHOTS, `${step.id}-failure-L.png`)
    await ctx.b?.screenshot(file).then(() => written.push(file)).catch(() => {})
  }
}

async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAU refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAU refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAU only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const email = `zz-au-admin-${ts}@example.invalid`
  const ctx = { ts, origin, shipmentIds: new Set(), locationIds: [] }
  try {
    ctx.admin = await mintIdentity(email, ['ADMIN', 'page-tms'])
    console.log('identity: temporary staff identity created (ADMIN, page-tms only)')
    ctx.token = ctx.admin.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.car = routerAs(ctx.token, 'tmsCarrierActions')
    ctx.ship = routerAs(ctx.token, 'tmsShipmentActions')
    await setupFixtures(ctx)
    console.log(`fixtures: customers ${ctx.custA.id}, ${ctx.custB.id}; carrier ${ctx.carrierId}; ${ctx.locationIds.length} locations`)
    ctx.b = await launchBrowser({ origin, storage: ctx.admin.storage, profilePrefix: 'bcat-au-', purpose: 'AU verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
    try {
      await ctx.b.navigate('/tms/dashboard'); await waitLoaded(ctx.b).catch(() => {})
      await walk.setTheme(ctx.b, 'light').catch(() => {})
      for (const step of AU_STEPS) await runStep(ctx, step)
    } finally { await ctx.b.close() }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${short(err).slice(0, 120)})`); process.exitCode = 1 })
    const gone = await deleteIdentity(email)
    console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
    if (!gone) process.exitCode = 1
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAU failed: ${err?.message ?? err}`); process.exit(1) })
}
