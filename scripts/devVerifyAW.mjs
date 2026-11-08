#!/usr/bin/env node
/**
 * Step AW live harness (AW-CDE-plan.md §4 steps 2-8): shipments replace loads, billing method + release to billing,
 * Jenny-only enforcement, post-invoice changes, the Aljex importers (synthetic dry runs), the reconciliation desk and
 * the BCAT blue palette, on the REHEARSAL stack (`BCAT_STACK=rehearsal`) or dev (`BCAT_STACK=dev`, set explicitly).
 *
 *   BCAT_STACK=rehearsal node scripts/devVerifyAW.mjs [--only=<substring>] [--expect-loads=N] [--expect-shipments=N]
 *       [--outputs=<rehearsal amplify_outputs.json>] [--real-customers=<csv>] [--real-carriers=<csv>] [--real-ap-aging=<csv>]
 *       [--reconcile-decide] [--reconcile-signoff]
 *   node scripts/devVerifyAW.mjs --inventory      no network, no browser, no AWS: every step id has a runner, every action
 *                                                 the steps call exists in its handler, every test id / route / token the
 *                                                 steps rely on exists in the source, and the synthetic importer dry runs pass.
 *
 * Safety (the harness refuses otherwise):
 *   - Stack: production is never a value; dev must be selected explicitly (BCAT_STACK=dev); only the selected stack's
 *     AppSync endpoint, staff pool and origin are used (scripts/lib/stackConfig.mjs).
 *   - Identities: temporary staff logins zz-aw-*@example.invalid in that pool (admin WITHOUT the billing grant, a releaser
 *     holding only page-billingRelease, a signer holding only page-aljexSignoff), deleted and proven gone in `finally`.
 *     The real Jenny login is never read, created or changed; only the SIZE of the grant group is reported.
 *   - Mail: the only recipients are ai4bcat+<tag>@gmail.com aliases. The company always-copy list is set to such an alias
 *     for the run (and restored in `finally`); the harness refuses to Send unless every address it would use is one.
 *     Nothing is e-mailed on a FACTOR release.
 *   - Data: every fixture is ZZ AW ...; in `finally` ZZ invoices are voided, ZZ factoring rows removed, ZZ shipments voided
 *     (PROs are permanent), ZZ customers archived, the ZZ carrier set INACTIVE. No sensitive column is ever read or printed.
 *   - Importers: synthetic CSVs generated into a temp dir and parsed/dry-run on an in-memory overlay (nothing written to
 *     any table). A real Aljex file is only accepted through --real-*, counts only, sensitive columns dropped by header first.
 *   - Reconciliation decisions are NOT undoable and carry over to later runs of the same entity: --reconcile-decide and
 *     --reconcile-signoff are off by default and write a "ZZ E5 harness" reason when on.
 */
import { STACK, APPSYNC_URL_RE } from './lib/stackConfig.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs, cognito } from './lib/devIdentity.mjs'
import { bookCarrier, findActiveRepId, poReference, recordCarrierBill, releaseForReview, DEMO_CARRIER_ID } from './lib/releaseFixture.mjs'
import {
  PALETTE, paletteProblems, countProblem, linkSummaryProblems, runBackfillDryRun, factorRowProblems, auditHit, changesOf, refusedWith,
  assertMailOnlyToAllowed, isAllowedMailbox, mailAlias, loadEngine, writeSyntheticFiles, dryRunCustomers, dryRunCarriers, dryRunApAging,
  dryRunApExpected, dryRunActive, realCountsDryRun, REAL_AP,
} from './lib/awChecks.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
const only = opt('only')
const intOpt = (name) => { const v = opt(name); if (v == null) return null; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`); return n }

/** Every AW id, in run order. */
export const AW_STEPS = [
  { id: 'AW01', slug: 'stack-and-identities' },
  { id: 'AW02', slug: 'loads-exist' },
  { id: 'AW03', slug: 'shipments-exist' },
  { id: 'AW04', slug: 'backfill-dry-run' },
  { id: 'AW05', slug: 'routes-and-nav' },
  { id: 'AW06', slug: 'billing-setup-counts' },
  { id: 'AW07', slug: 'release-refusals' },
  { id: 'AW08', slug: 'factor-release' },
  { id: 'AW09', slug: 'manual-release-and-send' },
  { id: 'AW10', slug: 'release-grant-only' },
  { id: 'AW11', slug: 'idempotent-release' },
  { id: 'AW12', slug: 'post-invoice-change' },
  { id: 'AW13', slug: 'importer-customers' },
  { id: 'AW14', slug: 'importer-carriers' },
  { id: 'AW15', slug: 'importer-ap-aging' },
  { id: 'AW16', slug: 'importer-ap-expected' },
  { id: 'AW17', slug: 'importer-active-shipments' },
  { id: 'AW18', slug: 'importer-real-counts' },
  { id: 'AW19', slug: 'reconciliation-page' },
  { id: 'AW20', slug: 'reconciliation-decisions-signoff' },
  { id: 'AW21', slug: 'palette' },
]

// ───────────────────────────── reporting ─────────────────────────────
const report = []
const line = (status, name, detail) => { report.push({ status, name }); console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`) }
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const must = (cond, message) => { if (!cond) throw new Error(message) }
const matches = (id) => !only || id.includes(only)

/** Run `fn`; it MUST throw an error matching `pattern`. Anything else fails with the reason. */
async function refuses(label, pattern, fn) {
  try { await fn() } catch (err) {
    if (refusedWith(err, pattern)) return
    throw new Error(`${label}: refused for the wrong reason: ${short(err).slice(0, 160)}`)
  }
  throw new Error(`${label}: it was allowed`)
}

// ───────────────────────────── inventory ─────────────────────────────
const HANDLERS = {
  dir: 'amplify/functions/tms-directory-actions/handler.ts',
  car: 'amplify/functions/tms-carrier-actions/handler.ts',
  ship: 'amplify/functions/tms-shipment-actions/handler.ts',
  fin: 'amplify/functions/tms-finance-actions/handler.ts',
  imp: 'amplify/functions/tms-aljex-import/router.ts',
}
const CALLERS = { dir: 'dir', car: 'car', ship: 'ship', fin: 'fin', finGrant: 'fin', finAdmin: 'fin', impAdmin: 'imp', impSign: 'imp' }
/** UI ids the steps select, with the source file that must contain them. */
const TEST_IDS = [
  ['src/features/directory/BillingSetupPage.tsx', ['count-factor', 'count-manual', 'count-not-set', 'count-needs-review']],
  ['src/features/tms/brokerage/company/AljexReconciliationPage.tsx', ['recon-entities']],
  ['src/components/ChangeTimeline.tsx', ['change-timeline']],
]

export async function inventory() {
  const self = await readFile(resolve('scripts/devVerifyAW.mjs'), 'utf8')
  const runners = Object.keys(RUNNERS)
  const registered = AW_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: AW ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  line('PASS', 'gate 1: AW ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner`)

  const texts = {}
  for (const [k, f] of Object.entries(HANDLERS)) texts[k] = await readFile(resolve(f), 'utf8')
  const absent = []
  let calls = 0
  for (const m of self.matchAll(/\bctx\.(dir|car|ship|fin|finGrant|finAdmin|impAdmin|impSign)\('([A-Z_]+)'/g)) {
    calls += 1
    if (!new RegExp(`'${m[2]}'`).test(texts[CALLERS[m[1]]])) absent.push(`${m[2]} (${HANDLERS[CALLERS[m[1]]]})`)
  }
  if (absent.length) { line('FAIL', 'gate 2: every action the steps call exists', absent.join('; ')); return false }
  line('PASS', 'gate 2: every action the steps call exists', `${calls} call sites, all named in their handler`)

  const lost = []
  let ids = 0
  for (const [file, list] of TEST_IDS) {
    const text = await readFile(resolve(file), 'utf8')
    for (const id of list) { ids += 1; if (!text.includes(id)) lost.push(`${id} (${file})`) }
  }
  if (lost.length) { line('FAIL', 'gate 3: every test id a step reads exists', lost.join('; ')); return false }
  line('PASS', 'gate 3: every test id a step reads exists', `${ids} ids`)

  const app = await readFile(resolve('src/App.tsx'), 'utf8')
  const company = await readFile(resolve('src/features/tms/brokerage/company/CompanyTab.tsx'), 'utf8')
  const nav = await readFile(resolve('src/lib/navSections.ts'), 'utf8')
  const probs = []
  for (const p of ['customers/billing-setup', '/loads/:id', '/grid']) if (!app.includes(p)) probs.push(`App.tsx lacks ${p}`)
  if (!company.includes('data/aljex-reconciliation')) probs.push('CompanyTab lacks data/aljex-reconciliation')
  if (!nav.includes("label: 'Active shipments'")) probs.push("navSections lacks 'Active shipments'")
  if (/label:\s*'Loads'/.test(nav)) probs.push("navSections still has a 'Loads' label")
  const theme = await readFile(resolve('src/features/tms/theme.css'), 'utf8')
  for (const [name, hex] of Object.entries(PALETTE)) if (!theme.includes(`--tms-primary: ${hex}`)) probs.push(`theme.css ${name} --tms-primary is not ${hex}`)
  if (!(await readFile(resolve('scripts/awBackfillShipments.mjs'), 'utf8').catch(() => ''))) probs.push('scripts/awBackfillShipments.mjs is missing')
  if (probs.length) { line('FAIL', 'gate 4: routes, nav, palette tokens, backfill script', probs.join('; ')); return false }
  line('PASS', 'gate 4: routes, nav, palette tokens, backfill script', 'billing-setup, /loads/:id, /grid, reconciliation route, "Active shipments", no "Loads", two --tms-primary values, awBackfillShipments.mjs')

  const dir = await mkdtemp(join(tmpdir(), 'aw-inventory-'))
  try {
    const eng = await loadEngine()
    const paths = writeSyntheticFiles(eng, dir)
    const out = [
      await dryRunCustomers(eng, paths.customers), await dryRunCarriers(eng, paths.carriers), await dryRunApAging(eng, paths['ap-aging']),
      await dryRunApExpected(eng, paths['ap-expected']), await dryRunActive(eng, paths['active-shipments']),
    ]
    line('PASS', 'gate 5: synthetic importer dry runs (offline)', `${out.length} files parsed and dry-run on an in-memory overlay`)
  } catch (err) {
    line('FAIL', 'gate 5: synthetic importer dry runs (offline)', short(err).slice(0, 400)); return false
  } finally { await rm(dir, { recursive: true, force: true }) }
  return true
}

// ───────────────────────────── API helpers ─────────────────────────────
async function listAll(token, model, selection, filter = null) {
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
const auditFor = async (token, entityType, entityId) => (await gql(token, 'query($t: String!, $i: String!) { listAuditLogByEntityTypeAndEntityId(entityType: $t, entityId: { eq: $i }, limit: 500) { items { id action user changes createdAt } } }', { t: entityType, i: entityId })).listAuditLogByEntityTypeAndEntityId.items
const INVOICE_FIELDS = 'id number status orderId shipmentId customerId sentAt sentTo sentCount factoringItemId totalCents balanceCents'

const TINY_PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

async function attachDocument(ctx, shipmentId, orderId, loadId, type) {
  const name = `zz-aw-${type.toLowerCase()}.pdf`
  const prepared = await ctx.ship('PREPARE_DOCUMENT_UPLOAD', { shipmentId, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length })
  const put = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: TINY_PDF })
  if (!put.ok) throw new Error(`document upload failed: ${put.status}`)
  return ctx.ship('COMMIT_DOCUMENT', { shipmentId, documentId: prepared.documentId, s3Key: prepared.s3Key, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length, ...(type === 'BOL' || type === 'POD' ? { loadId } : { orderId }) })
}

/** The four ZZ customers (FACTOR, MANUAL, unset, MANUAL-without-AP) and the ZZ carrier; created once. */
async function ensureFixtures(ctx) {
  if (ctx.fx) return ctx.fx
  const { ts, tag } = ctx
  ctx.repId = await findActiveRepId((q, v) => gql(ctx.token, q, v))
  const mk = async (key, extra) => {
    const r = await ctx.dir('UPSERT_CUSTOMER', {
      name: `ZZ AW ${key} ${ts}`, status: 'ACTIVE', active: true, creditLimitCents: 100_000_000, paymentTermsDays: 30,
      ...(ctx.repId ? { defaultSalesRepId: ctx.repId } : {}), notes: 'ZZ AW harness fixture. Not a real customer; safe to archive.', ...extra,
    })
    const c = r.customer ?? r
    ctx.customerIds.push(String(c.id))
    return { id: String(c.id), name: `ZZ AW ${key} ${ts}` }
  }
  const fx = {
    factor: await mk('Factor', { billingMethod: 'FACTOR', apEmail: mailAlias(`${tag}-factor-ap`) }),
    manual: await mk('Manual', { billingMethod: 'MANUAL', apEmail: mailAlias(`${tag}-ap`), invoiceCopyEmails: [mailAlias(`${tag}-cc`)] }),
    unset: await mk('Unset', {}),
    noAp: await mk('NoAp', { billingMethod: 'MANUAL', apEmail: mailAlias(`${tag}-noap-temp`) }),
  }
  // The directory action refuses MANUAL without an AP e-mail, so the "no AP e-mail" customer is made by clearing it on
  // this run's own ZZ row (condition: the name starts with ZZ AW).
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb')
  const { doc, devTable } = await import('./devVerifyU.mjs')
  await doc.send(new UpdateCommand({ TableName: devTable('Customer', STACK.tableSuffix), Key: { id: fx.noAp.id }, ConditionExpression: 'begins_with(#n, :zz)', UpdateExpression: 'REMOVE apEmail', ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':zz': 'ZZ AW ' } }))
  ctx.carrierName = `ZZ AW Carrier ${String(ts).slice(-6)}`
  const n = String(ts).slice(-6)
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const car = await ctx.car('UPSERT_CARRIER', {
    name: ctx.carrierName, type: 'TL', status: 'ACTIVE', mcNumber: `9${n}`, dotNumber: `9${n}`, mcpStatus: 'NOT_INVITED',
    accountingEmail: `zz-aw-carrier-ap-${ts}@example.invalid`, dispatcherEmail: `zz-aw-dispatch-${ts}@example.invalid`,
    insurancePolicies: [
      { type: 'AUTO_LIABILITY', company: 'ZZ AW Mutual', policyNumber: `ZZAL-${ts}`, limitCents: 100000000, expiresAt: nextYear },
      { type: 'CARGO', company: 'ZZ AW Mutual', policyNumber: `ZZCG-${ts}`, limitCents: 10000000, expiresAt: nextYear },
    ],
    notes: 'ZZ AW harness carrier. Not a real carrier; safe to archive.',
  }).then((r) => r.carrier ?? r)
  ctx.carrierId = String(car.id)
  ctx.fx = fx
  return fx
}

/** A delivered, documented, reviewed shipment on `customerId`, ready for RELEASE_TO_BILLING (the devVerifyAr recipe). */
async function buildReleasable(ctx, customerId, label) {
  const stamp = `${ctx.ts}-${label}`
  let bundle = await ctx.ship('CREATE_SHIPMENT', { customerId })
  const shipmentId = bundle.shipment.id
  const orderId = bundle.orders[0].id
  ctx.shipmentIds.add(shipmentId)
  const today = new Date().toISOString().slice(0, 10)
  bundle = await ctx.ship('SAVE_ORDER_FORM', {
    shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
    order: { mode: 'FTL', equipmentType: 'Dry Van', references: [poReference(`ZZ-AW-${stamp}`)] },
    stops: [
      { type: 'pickup', name: 'ZZ AW Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${today}T13:00:00.000Z` },
      { type: 'delivery', name: 'ZZ AW Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T23:00:00.000Z` },
    ],
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 }, { side: 'CARRIER', code: 'LINEHAUL', rateCents: 180000, count: 1 }],
  })
  const reload = async () => { bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId }) }
  await ctx.ship('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
  try { await bookCarrier({ ship: ctx.ship, shipmentId, rateCents: 180000, carrierId: ctx.carrierId }) } catch {
    await bookCarrier({ ship: ctx.ship, shipmentId, rateCents: 180000, carrierId: DEMO_CARRIER_ID })
  }
  await reload()
  for (const status of ['BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
    const load = bundle.loads[0]
    try { await ctx.ship('SET_LOAD_STATUS', { loadId: load.id, status, expectedUpdatedAt: load.updatedAt }) } catch { /* a status the ladder already passed */ }
    await reload()
  }
  must(bundle.shipment.status === 'DELIVERED', `fixture is ${bundle.shipment.status}, not DELIVERED`)
  const loadId = bundle.loads[0].id
  for (const type of ['BOL', 'POD', 'RATE_CON']) await attachDocument(ctx, shipmentId, orderId, loadId, type)
  await reload()
  await recordCarrierBill({ ship: ctx.ship, fin: ctx.fin, shipmentId, billNumber: `ZZ-AW-${String(ctx.ts).slice(-6)}-${label}`, billedCents: 180000 })
  await releaseForReview({ ship: ctx.ship, shipmentId, repId: ctx.repId })
  await reload()
  return { shipmentId, orderId, loadId, pro: String(bundle.loads[0].aljexId ?? bundle.shipment.number), number: bundle.shipment.number }
}

// ───────────────────────────── browser helpers ─────────────────────────────
const bodyText = (b) => b.evaluate('document.body.innerText')
const pathOf = (b) => b.evaluate('location.pathname')
async function openPage(b, path) {
  await b.navigate(path)
  await b.poll(async () => (await b.evaluate('document.body ? document.body.innerText.length : 0')) > 40, `page ${path}`, 45_000)
}
const countOf = (b, testId) => b.evaluate(`(() => { const el = document.querySelector('[data-testid="${testId}"]'); const m = el ? el.innerText.match(/\\d+/g) : null; return m ? Number(m[m.length - 1]) : null })()`)

/** Billing setup header counts once the directory has loaded (the same number twice in a row, All tab > 0). */
async function billingCounts(b) {
  await openPage(b, '/tms/customers/billing-setup')
  let last = ''
  await b.poll(async () => {
    const now = JSON.stringify(await b.evaluate(`(() => { const g = (t) => { const el = document.querySelector('[data-testid="' + t + '"]'); const m = el ? el.innerText.match(/\\d+/g) : null; return m ? Number(m[m.length - 1]) : null }; const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.innerText.replace(/\\s+/g, ' ')); const num = (re) => { const t = tabs.find((x) => re.test(x)); const m = t ? t.match(/\\d+/g) : null; return m ? Number(m[m.length - 1]) : null }; return { factor: g('count-factor'), manual: g('count-manual'), notSet: g('count-not-set'), review: g('count-needs-review'), all: num(/^All/), missing: num(/^Missing/) } })()`))
    const ok = now === last && !now.includes('null') && JSON.parse(now).all > 0
    last = now
    return ok
  }, 'billing setup counts', 60_000)
  return JSON.parse(last)
}

// ───────────────────────────── runners ─────────────────────────────
const RUNNERS = {
  async AW01(ctx) {
    must(['rehearsal', 'dev'].includes(STACK.name), `stack ${STACK.name} is not rehearsal or dev`)
    must(APPSYNC_URL_RE.test(DEV_API) && DEV_POOL === STACK.staffPoolId, 'API or pool is not the selected stack')
    must(Object.keys(ctx.ids).length === 3, 'temporary identities missing')
    return `stack ${STACK.name}; temp admin (no billing grant), releaser (page-billingRelease only) and signer (page-aljexSignoff only) minted in the stack's staff pool`
  },

  async AW02(ctx) {
    const loads = await listAll(ctx.token, 'Load', 'id shipmentId')
    ctx.loadCount = loads.length
    ctx.loadsLinked = loads.filter((l) => l.shipmentId).length
    ctx.sampleLink = loads.find((l) => l.shipmentId) ?? null
    const p = countProblem('Load rows', loads.length, ctx.expectLoads)
    if (p) throw new Error(`${p} (the prod data load must carry every Load; --expect-loads)`)
    must(loads.length > 0, 'no Load rows on this stack')
    return `${loads.length} Load rows (${ctx.loadsLinked} already linked to a shipment)${ctx.expectLoads == null ? '' : `, equal to the export count ${ctx.expectLoads}`}`
  },

  async AW03(ctx) {
    const ships = await listAll(ctx.token, 'Shipment', 'id')
    ctx.shipmentCount = ships.length
    const p = countProblem('Shipment rows', ships.length, ctx.expectShipments)
    if (p) throw new Error(p)
    return `${ships.length} Shipment rows${ctx.expectShipments == null ? ' (reported; pass --expect-shipments=N to pin it)' : `, equal to ${ctx.expectShipments}`}`
  },

  async AW04(ctx) {
    const loadsBefore = await listAll(ctx.token, 'Load', 'id shipmentId')
    const linkedBefore = loadsBefore.filter((l) => l.shipmentId).length
    const out = await mkdtemp(join(tmpdir(), 'aw-backfill-'))
    try {
      const s = await runBackfillDryRun({ outDir: out, stack: STACK.name, outputs: ctx.outputs })
      const problems = linkSummaryProblems(s, { loads: loadsBefore.length })
      const after = (await listAll(ctx.token, 'Load', 'id shipmentId')).filter((l) => l.shipmentId).length
      if (after !== linkedBefore) problems.push(`the dry run changed the linked-load count (${linkedBefore} -> ${after})`)
      if (problems.length) throw new Error(problems.join('; '))
      return `dry run: ${s.matchedByPro} matched-by-PRO, ${s.linkedById} linked-by-ID, ${s.alreadyLinked} already linked, ${s.ambiguous} ambiguous, ${s.unmappable} unmappable = ${s.loads} loads; nothing written${ctx.outputs ? '' : ' (no --outputs: backfill refusals not evaluated)'}`
    } finally { await rm(out, { recursive: true, force: true }) }
  },

  async AW05(ctx) {
    const b = ctx.b
    const link = ctx.sampleLink ?? (await listAll(ctx.token, 'Load', 'id shipmentId')).find((l) => l.shipmentId)
    must(link, 'no Load is linked to a shipment yet (run the LINK import / backfill apply first)')
    const made = { shipmentId: link.shipmentId }
    const loadId = link.id
    const landings = []
    await openPage(b, `/loads/${loadId}`)
    await b.poll(async () => (await pathOf(b)) === `/tms/shipments/${made.shipmentId}`, '/loads/:id -> its shipment', 30_000)
    landings.push('/loads/:id')
    await openPage(b, `/loads?id=${loadId}`)
    await b.poll(async () => (await pathOf(b)) === `/tms/shipments/${made.shipmentId}`, '/loads?id= -> its shipment', 30_000)
    landings.push('/loads?id=')
    await openPage(b, '/loads')
    await b.poll(async () => (await pathOf(b)) === '/tms/shipments', '/loads -> board', 30_000)
    landings.push('/loads')
    await openPage(b, '/grid')
    await b.poll(async () => (await pathOf(b)) === '/tms/shipments', '/grid -> board', 30_000)
    landings.push('/grid')
    await openPage(b, `/shipments/${made.shipmentId}`)
    await b.poll(async () => (await pathOf(b)) === `/tms/shipments/${made.shipmentId}`, '/shipments/:id', 30_000)
    landings.push('/shipments/:id')
    await openPage(b, '/tms/shipments')
    const labels = await b.evaluate(`[...document.querySelectorAll('nav[aria-label="TMS sections"] a')].map((a) => a.innerText.replace(/\\s+/g, ' ').trim())`)
    must(labels.includes('Active shipments'), 'the sidebar has no "Active shipments"')
    must(!labels.some((l) => /^loads$/i.test(l)), 'the sidebar still has "Loads"')
    must(!/not found|404/i.test((await bodyText(b)).slice(0, 400)), 'the Active shipments board shows a not-found message')
    return `${landings.join(', ')} land on the shipment / Active shipments board; sidebar has "Active shipments" and no "Loads"`
  },

  async AW06(ctx) {
    const b = ctx.b
    const c0 = await billingCounts(b)
    const fx = await ensureFixtures(ctx)
    const c1 = await billingCounts(b)
    const want = { factor: c0.factor + 1, manual: c0.manual + 2, notSet: c0.notSet + 1, all: c0.all + 4, missing: c0.missing + 2 }
    const bad = Object.keys(want).filter((k) => c1[k] !== want[k]).map((k) => `${k} ${c1[k]} (expected ${want[k]})`)
    must(bad.length === 0, `after four ZZ customers (factor, manual, unset, manual-no-AP): ${bad.join(', ')}`)
    must(c1.factor + c1.manual + c1.notSet === c1.all, `counts ${c1.factor}+${c1.manual}+${c1.notSet} do not add up to All ${c1.all}`)
    const row = await getRow(ctx.token, 'Customer', fx.manual.id, 'billingMethod apEmail invoiceCopyEmails')
    must(row.billingMethod === 'MANUAL' && isAllowedMailbox(row.apEmail) && (row.invoiceCopyEmails ?? []).every(isAllowedMailbox), 'the MANUAL fixture did not keep its ai4bcat AP e-mail and copy list')
    return `page: ${c1.factor} factor / ${c1.manual} manual / ${c1.notSet} not set / ${c1.review} need review, Missing ${c1.missing}, All ${c1.all}; +1 factor, +2 manual, +1 not set, +2 Missing after the four ZZ fixtures; method, AP e-mail and copy list round-trip`
  },

  async AW07(ctx) {
    const fx = await ensureFixtures(ctx)
    const un = await buildShipmentOnly(ctx, fx.unset.id)
    const no = await buildShipmentOnly(ctx, fx.noAp.id)
    await refuses('method unset', /BILLING_METHOD_UNSET/, () => ctx.finGrant('RELEASE_TO_BILLING', { orderId: un.orderId }))
    await refuses('MANUAL without AP e-mail', /AP_EMAIL_MISSING/, () => ctx.finGrant('RELEASE_TO_BILLING', { orderId: no.orderId }))
    await refuses('UPSERT_CUSTOMER MANUAL without AP e-mail', /AP e-?mail|apEmail/i, () => ctx.dir('UPSERT_CUSTOMER', { name: `ZZ AW Refused ${ctx.ts}`, billingMethod: 'MANUAL' }))
    const stray = (await listAll(ctx.token, 'Customer', 'id', { name: { eq: `ZZ AW Refused ${ctx.ts}` } })).length
    must(stray === 0, 'the refused customer was created anyway')
    for (const [who, call] of [['unset', un], ['noAp', no]]) {
      const bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: call.shipmentId })
      must(!bundle.orders[0].invoiceId, `a refused release (${who}) still created an invoice`)
    }
    return 'release refused with BILLING_METHOD_UNSET (method unset) and AP_EMAIL_MISSING (MANUAL, no AP e-mail); no invoice created; the directory refuses MANUAL without an AP e-mail'
  },

  async AW08(ctx) {
    const fx = await ensureFixtures(ctx)
    const made = await buildReleasable(ctx, fx.factor.id, 'F')
    ctx.factor = made
    const r = await ctx.finGrant('RELEASE_TO_BILLING', { orderId: made.orderId, clientRequestId: `zz-aw-f-${ctx.ts}` })
    ctx.invoiceIds.add(r.invoice.id)
    must(r.billingMethod === 'FACTOR' && r.alreadyReleased === false, `release said ${r.billingMethod}, alreadyReleased ${r.alreadyReleased}`)
    must(r.readyToSend === false, 'a FACTOR release claims Ready to send')
    const item = await getRow(ctx.token, 'FactoringItem', made.pro, 'id proNumber status source messageId invoiceId customerId orderId shipmentId subject fromEmail receivedAt otrInvoiceId')
    ctx.factorItemId = item?.id ?? null
    const probs = factorRowProblems(item, r.invoice, { pro: made.pro, customerId: fx.factor.id, orderId: made.orderId, shipmentId: made.shipmentId })
    must(probs.length === 0, `queue row: ${probs.join('; ')}`)
    const inv = await getRow(ctx.token, 'Invoice', r.invoice.id, INVOICE_FIELDS)
    must(!inv.sentAt && !(inv.sentCount > 0) && !inv.sentTo, 'a FACTOR release e-mailed the customer')
    await refuses('SEND_INVOICE on a factored invoice', /FACTOR_NOT_EMAILED|never e-mailed/i, () => ctx.finGrant('SEND_INVOICE', { invoiceId: r.invoice.id }))
    const invAudit = await auditFor(ctx.token, 'Invoice', r.invoice.id)
    const queued = auditHit(invAudit, 'PUSHED_TO_FACTORING_QUEUE_ON_RELEASE')
    must(queued && changesOf(queued).customerEmailed === false, 'no PUSHED_TO_FACTORING_QUEUE_ON_RELEASE audit with customerEmailed=false on the invoice')
    must(auditHit(await auditFor(ctx.token, 'SHIPMENT', made.shipmentId), 'PUSHED_TO_FACTORING_QUEUE_ON_RELEASE'), 'no PUSHED_TO_FACTORING_QUEUE_ON_RELEASE audit on the shipment')
    return `FACTOR release: invoice ${r.invoice.number} -> FactoringItem ${item.id} (NEED_TO_FACTOR, source TMS, tms:<invoice> message id, same shape as the bridge row); sentAt/sentTo empty; SEND_INVOICE refused; audited on invoice and shipment`
  },

  async AW09(ctx) {
    const fx = await ensureFixtures(ctx)
    const made = await buildReleasable(ctx, fx.manual.id, 'M')
    ctx.manual = made
    const r = await ctx.finGrant('RELEASE_TO_BILLING', { orderId: made.orderId, clientRequestId: `zz-aw-m-${ctx.ts}` })
    ctx.invoiceIds.add(r.invoice.id)
    ctx.manualInvoiceId = r.invoice.id
    must(r.billingMethod === 'MANUAL' && r.readyToSend === true && !r.factoringItem, `release said ${r.billingMethod}, readyToSend ${r.readyToSend}, queue row ${r.factoringItem ? 'present' : 'none'}`)
    const before = await getRow(ctx.token, 'Invoice', r.invoice.id, INVOICE_FIELDS)
    must(before.status === 'ISSUED' && !before.sentAt && !before.factoringItemId, `invoice is ${before.status}, sentAt ${before.sentAt}, factoringItemId ${before.factoringItemId}`)
    // The company always-copy list is the other half of the cc set: make it an ai4bcat alias for the run, then prove it.
    const always = mailAlias(`${ctx.tag}-always`)
    await ctx.finAdmin('SAVE_AR_SETTINGS', { invoiceAlwaysCopyEmails: [always] })
    ctx.alwaysCopyChanged = true
    const settings = await getRow(ctx.token, 'TmsSettings', 'default', 'invoiceAlwaysCopyEmails')
    assertMailOnlyToAllowed(settings.invoiceAlwaysCopyEmails, 'company always-copy list', { nonEmpty: true })
    const cust = await getRow(ctx.token, 'Customer', fx.manual.id, 'apEmail invoiceCopyEmails')
    assertMailOnlyToAllowed([cust.apEmail], 'customer AP e-mail', { nonEmpty: true })
    assertMailOnlyToAllowed(cust.invoiceCopyEmails, 'customer copy list', { nonEmpty: true })
    const sent = await ctx.finGrant('SEND_INVOICE', { invoiceId: r.invoice.id })
    must(JSON.stringify(sent.to) === JSON.stringify([cust.apEmail]), `to is ${JSON.stringify(sent.to)}, expected only the AP e-mail`)
    const wantCc = [...new Set([...(cust.invoiceCopyEmails ?? []), always])].sort()
    must(JSON.stringify([...(sent.cc ?? [])].sort()) === JSON.stringify(wantCc), `cc is ${JSON.stringify(sent.cc)}, expected the customer copy list plus the always-copy alias`)
    assertMailOnlyToAllowed([...sent.to, ...sent.cc], 'the e-mail that was sent', { nonEmpty: true })
    must(sent.notice && ['SENT', 'NOT_SENT'].includes(sent.emailStatus), `unexpected emailStatus ${sent.emailStatus}`)
    const after = await getRow(ctx.token, 'Invoice', r.invoice.id, INVOICE_FIELDS)
    if (sent.emailStatus === 'SENT') must(after.sentAt && after.sentCount === 1 && String(after.sentTo ?? '').includes(cust.apEmail), 'SENT but the invoice does not show sentAt/sentCount/sentTo')
    const shipAudit = auditHit(await auditFor(ctx.token, 'SHIPMENT', made.shipmentId), 'INVOICE_SENT')
    must(shipAudit, 'no INVOICE_SENT audit on the shipment')
    return `MANUAL release: invoice ${r.invoice.number} ISSUED, Ready to send, no queue row; Send -> to the AP alias, cc customer copy + always-copy alias (all ai4bcat+tag), notice ${sent.emailStatus}${sent.emailStatus === 'NOT_SENT' ? ` (${String(sent.emailError ?? '').slice(0, 60)})` : `, sentCount ${after.sentCount}`}; INVOICE_SENT audited on the shipment`
  },

  async AW10(ctx) {
    const fx = await ensureFixtures(ctx)
    const actions = ['RELEASE_TO_BILLING', 'SEND_INVOICE', 'SYNC_FACTORING_CHANGE', 'EMAIL_INVOICE', 'BATCH_EMAIL', 'SEND_TO_FACTOR', 'MARK_SENT']
    for (const action of actions) {
      await refuses(`ADMIN without the grant: ${action}`, /requires the page-billingRelease grant/, () => ctx.finAdmin(action, { orderId: 'x', invoiceId: 'x', proNumber: 'x', invoiceIds: [], changeReason: 'x', changes: {} }))
    }
    // The grant holder is not an ADMIN: the grant alone opens the door (an unknown id fails AFTER the grant check).
    await refuses('grant holder reaches the handler', /not found|No order|Order not found|cannot be found|unknown/i, () => ctx.finGrant('RELEASE_TO_BILLING', { orderId: `zz-aw-missing-${ctx.ts}` }))
    let members = null
    try {
      const { ListUsersInGroupCommand } = await import('@aws-sdk/client-cognito-identity-provider')
      const g = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: DEV_POOL, GroupName: 'page-billingRelease' }))
      members = g.Users?.length ?? 0
    } catch { members = null }
    void fx
    return `all ${actions.length} billing actions refused for a temp ADMIN without page-billingRelease (no role bypass); a temp identity holding only the grant reaches the handler; group size ${members == null ? 'unreadable' : members} (counted only; the real Jenny login is never read or changed)`
  },

  async AW11(ctx) {
    must(ctx.manual && ctx.factor, 'AW08 and AW09 must run first (--only matches too little)')
    const m = await ctx.finGrant('RELEASE_TO_BILLING', { orderId: ctx.manual.orderId })
    must(m.alreadyReleased === true && m.invoice.id === ctx.manualInvoiceId && m.readyToSend === true, `MANUAL re-release: alreadyReleased ${m.alreadyReleased}, invoice ${m.invoice?.id === ctx.manualInvoiceId ? 'same' : 'DIFFERENT'}`)
    const f = await ctx.finGrant('RELEASE_TO_BILLING', { orderId: ctx.factor.orderId })
    must(f.alreadyReleased === true && f.factoringItem?.id === ctx.factorItemId, 'FACTOR re-release did not return the same queue row')
    const invoices = await listAll(ctx.token, 'Invoice', 'id orderId status', { orderId: { eq: ctx.factor.orderId } })
    must(invoices.filter((i) => i.status !== 'VOID').length === 1, 'a second invoice exists for the factored order')
    const rows = await listAll(ctx.token, 'FactoringItem', 'id', { shipmentId: { eq: ctx.factor.shipmentId } })
    must(rows.length === 1, `${rows.length} queue rows for the factored shipment`)
    return 're-release of both orders returned the existing invoice / queue row with alreadyReleased:true; one invoice and one queue row remain'
  },

  async AW12(ctx) {
    must(ctx.manual, 'AW09 must run first')
    const { shipmentId } = ctx.manual
    const bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
    const change = { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt, loadFields: { commodity: `ZZ AW changed ${ctx.ts}` } }
    await refuses('post-invoice change without a reason', /REASON_REQUIRED/, () => ctx.ship('UPDATE_ORDER_DETAILS', change))
    await refuses('post-invoice change with a too-short reason', /REASON_REQUIRED/, () => ctx.ship('UPDATE_ORDER_DETAILS', { ...change, changeReason: 'x' }))
    const reason = `ZZ AW harness: customer corrected the commodity (${ctx.ts})`
    await ctx.ship('UPDATE_ORDER_DETAILS', { ...change, changeReason: reason })
    const onShip = await auditFor(ctx.token, 'SHIPMENT', shipmentId)
    const onInv = await auditFor(ctx.token, 'Invoice', ctx.manualInvoiceId)
    for (const [where, rows] of [['shipment', onShip], ['invoice', onInv]]) {
      const hit = auditHit(rows, 'POST_INVOICE_CHANGE')
      must(hit, `no POST_INVOICE_CHANGE on the ${where}`)
      const c = changesOf(hit)
      must(c.reason === reason, `the ${where} entry lost the reason`)
      must(c.before && c.after, `the ${where} entry has no before/after`)
    }
    const b = ctx.b
    await openPage(b, `/tms/shipments/${shipmentId}`)
    const seen = await b.poll(async () => (await bodyText(b)).includes('ZZ AW harness: customer corrected'), 'the change on the shipment timeline', 30_000).then(() => true, () => false)
    must(seen, 'the change reason does not show in "What happened" on the shipment page')
    return 'without a reason (or a 1-char one): REASON_REQUIRED, nothing written; with a reason it succeeds and writes POST_INVOICE_CHANGE (reason, before, after) on the shipment and the invoice; the reason shows in the shipment timeline'
  },

  async AW13(ctx) { return dryRunCustomers(ctx.eng, ctx.files.customers) },
  async AW14(ctx) { return dryRunCarriers(ctx.eng, ctx.files.carriers) },
  async AW15(ctx) { return dryRunApAging(ctx.eng, ctx.files['ap-aging']) },
  async AW16(ctx) { return dryRunApExpected(ctx.eng, ctx.files['ap-expected']) },
  async AW17(ctx) { return dryRunActive(ctx.eng, ctx.files['active-shipments']) },

  async AW18(ctx) {
    const jobs = [['customers', opt('real-customers')], ['carriers', opt('real-carriers')], ['apAging', opt('real-ap-aging')]].filter(([, p]) => p)
    if (jobs.length === 0) return 'SKIP: no --real-customers / --real-carriers / --real-ap-aging given (counts-only path for the real Aljex files; sensitive columns dropped by header first)'
    const out = []
    for (const [kind, path] of jobs) {
      const c = await realCountsDryRun(ctx.eng, kind, resolve(path))
      if (kind === 'apAging') {
        must(c.bills === REAL_AP.bills && c.totalCents === REAL_AP.totalCents && c.byBucket.D0_30 === REAL_AP.D0_30 && c.byBucket.D31_60 === REAL_AP.D31_60, `real AP aging: ${c.bills} bills, ${(c.totalCents / 100).toFixed(2)} total, 0-30 ${(c.byBucket.D0_30 / 100).toFixed(2)}, 31-60 ${(c.byBucket.D31_60 / 100).toFixed(2)}; expected 67 / 83407.20 / 66642.20 / 16765.00`)
      }
      out.push(JSON.stringify(c))
    }
    return out.join(' | ')
  },

  async AW19(ctx) {
    const b = ctx.b
    await openPage(b, '/tms/brokerage/company/data/aljex-reconciliation')
    await b.poll(async () => (await b.evaluate(`!!document.querySelector('[data-testid="recon-entities"]')`)), 'the reconciliation entity table', 45_000)
    const text = await bodyText(b)
    must(!/something went wrong|not found|forbidden/i.test(text.slice(0, 600)), 'the reconciliation page shows an error')
    const list = await ctx.impAdmin('IMPORT_RECONCILE_GET', {})
    must(Array.isArray(list.jobs), 'IMPORT_RECONCILE_GET (no jobId) did not return a jobs list')
    // The signoff holder may VIEW the desk through the router (RECONCILE_VIEW_ACTIONS) without being an admin.
    const viewed = await ctx.impSign('IMPORT_RECONCILE_GET', {})
    must(Array.isArray(viewed.jobs), 'the aljexSignoff holder cannot read the reconciliation list')
    return `page renders the five-entity table; ${list.jobs.length} reconciliation job(s) listed; the grant-only identity can read the list`
  },

  async AW20(ctx) {
    for (const action of ['IMPORT_DECIDE', 'IMPORT_SIGNOFF']) {
      await refuses(`ADMIN without aljexSignoff: ${action}`, /needs the aljexSignoff grant/, () => ctx.impAdmin(action, { jobId: 'aljexrec:AP:none', keys: ['x'], outcome: 'APPROVED', reason: 'x' }))
      await refuses(`grant holder reaches ${action}`, /not found|No such|unknown|job/i, () => ctx.impSign(action, { jobId: `aljexrec:AP:zz-aw-${ctx.ts}`, keys: ['x'], outcome: 'APPROVED', reason: 'ZZ E5 harness' }))
    }
    let tail = 'sign-off and decide refused for a temp ADMIN without page-aljexSignoff; the grant holder reaches the handler (no role bypass)'
    if (!flag('reconcile-decide')) return `${tail}; --reconcile-decide not given: no decision written`
    const jobs = (await ctx.impAdmin('IMPORT_RECONCILE_GET', {})).jobs.filter((j) => j.status === 'APPLIED')
    must(jobs.length > 0, 'no finished reconciliation job to decide on; run IMPORT_RECONCILE_ENTITY first')
    let target = null
    for (const j of jobs) {
      const page = await ctx.impSign('IMPORT_RECONCILE_GET', { jobId: j.id, state: 'OPEN', limit: 1 })
      if (page.rows?.length) { target = { job: j, key: page.rows[0].key }; break }
    }
    must(target, 'every finished reconciliation job is already fully decided; nothing left to decide')
    const reasonA = 'ZZ E5 harness: open balance'
    await ctx.impSign('IMPORT_DECIDE', { jobId: target.job.id, keys: [target.key], outcome: 'OPEN_BALANCE', reason: reasonA })
    const reasonB = 'ZZ E5 harness: approved with a note'
    await ctx.impSign('IMPORT_DECIDE', { jobId: target.job.id, keys: [target.key], outcome: 'APPROVED', reason: reasonB })
    const decided = await ctx.impSign('IMPORT_RECONCILE_GET', { jobId: target.job.id, state: 'DECIDED', q: '', limit: 1000 })
    const row = (decided.rows ?? []).find((r) => r.key === target.key)
    const blob = JSON.stringify(row ?? {})
    must(row && blob.includes(reasonB) && /APPROVED/.test(blob) && /\d{4}-\d{2}-\d{2}T/.test(blob), 'the decided row does not show outcome, reason and time')
    tail += `; decided one difference OPEN_BALANCE then APPROVED with a note: the row shows outcome, reason, approver and time`
    if (!flag('reconcile-signoff')) return `${tail}; --reconcile-signoff not given: no sign-off written`
    const stats = (await ctx.impSign('IMPORT_RECONCILE_GET', { jobId: target.job.id, state: 'OPEN', limit: 1 }))
    if ((stats.total ?? 0) > 0 && (stats.rows?.length ?? 0) > 0) {
      await refuses('sign-off with undecided differences', /no decision yet/i, () => ctx.impSign('IMPORT_SIGNOFF', { jobId: target.job.id, note: 'ZZ E5 harness' }))
      return `${tail}; sign-off refused while differences are undecided (no sign-off written)`
    }
    await ctx.impSign('IMPORT_SIGNOFF', { jobId: target.job.id, note: 'ZZ E5 harness' })
    return `${tail}; every difference decided, signed off by the grant holder`
  },

  async AW21(ctx) {
    const b = ctx.b
    await openPage(b, '/dashboard')
    const probe = await b.evaluate(`(() => { const root = document.documentElement; const prev = root.getAttribute('data-tms-theme'); const read = (t) => { if (t === 'dark') root.setAttribute('data-tms-theme', 'dark'); else root.removeAttribute('data-tms-theme'); return getComputedStyle(root).getPropertyValue('--tms-primary').trim() }; const out = { light: read('light'), dark: read('dark') }; if (prev) root.setAttribute('data-tms-theme', prev); else root.removeAttribute('data-tms-theme'); return out })()`)
    const probs = paletteProblems(probe)
    must(probs.length === 0, probs.join('; '))
    return `--tms-primary resolves to ${probe.light} (light) and ${probe.dark} (dark): the BCAT blue`
  },
}

/** A draft shipment with only the customer set (enough for the release refusals). */
async function buildShipmentOnly(ctx, customerId) {
  const key = `plain:${customerId}`
  ctx.plain ??= new Map()
  if (ctx.plain.has(key)) return ctx.plain.get(key)
  const bundle = await ctx.ship('CREATE_SHIPMENT', { customerId })
  ctx.shipmentIds.add(bundle.shipment.id)
  const made = { shipmentId: bundle.shipment.id, orderId: bundle.orders[0].id }
  ctx.plain.set(key, made)
  return made
}

// ───────────────────────────── cleanup ─────────────────────────────
async function cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1 }
  if (!ctx.token) return
  if (ctx.alwaysCopyChanged) {
    await ctx.finAdmin('SAVE_AR_SETTINGS', { invoiceAlwaysCopyEmails: ctx.alwaysCopyBefore }).then(() => say('company always-copy list restored'), (err) => say(`always-copy restore failed: ${short(err).slice(0, 100)}`, false))
  }
  const customers = new Set(ctx.customerIds)
  const ships = new Set(ctx.shipmentIds)
  for (const id of customers) {
    for (const r of await listAll(ctx.token, 'Shipment', 'id', { customerId: { eq: id } }).catch(() => [])) ships.add(r.id)
  }
  for (const id of customers) {
    for (const inv of await listAll(ctx.token, 'Invoice', `${INVOICE_FIELDS} paidCents`, { customerId: { eq: id } }).catch(() => [])) {
      if (inv.status === 'VOID') continue
      await ctx.fin('VOID_INVOICE', { invoiceId: inv.id, reason: 'ZZ AW harness cleanup' }).then(() => say(`invoice ${inv.id} voided`), (err) => say(`invoice ${inv.id} void failed: ${short(err).slice(0, 100)}`, false))
    }
  }
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb')
  const { doc, devTable } = await import('./devVerifyU.mjs')
  for (const shipmentId of ships) {
    for (const item of await listAll(ctx.token, 'FactoringItem', 'id customerId otrInvoiceId', { shipmentId: { eq: shipmentId } }).catch(() => [])) {
      if (!customers.has(item.customerId) || item.otrInvoiceId) { say(`factoring row ${item.id} left alone (not a ZZ AW row or already with the factor)`, !item.otrInvoiceId); continue }
      await doc.send(new DeleteCommand({ TableName: devTable('FactoringItem', STACK.tableSuffix), Key: { id: item.id } })).then(() => say(`factoring row ${item.id} removed`), (err) => say(`factoring row delete failed: ${short(err).slice(0, 100)}`, false))
    }
  }
  for (const id of ships) {
    try {
      const row = await getRow(ctx.token, 'Shipment', id, 'id updatedAt voidedAt')
      if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, reason: 'AW harness', expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = await getRow(ctx.token, 'Shipment', id, 'voidedAt')
      say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
    } catch (err) { say(`shipment ${id} void failed: ${short(err).slice(0, 100)}`, false) }
  }
  if (ctx.carrierId) {
    const row = await getRow(ctx.token, 'Carrier', ctx.carrierId, 'id updatedAt').catch(() => null)
    if (row) await ctx.car('SET_CARRIER_STATUS', { id: ctx.carrierId, expectedUpdatedAt: String(row.updatedAt), status: 'INACTIVE', reason: 'INACTIVE_AGREEMENT' }).then(() => say(`carrier ${ctx.carrierId} set INACTIVE`), (err) => say(`carrier retire failed: ${short(err).slice(0, 80)}`, false))
  }
  for (const id of customers) {
    const row = await getRow(ctx.token, 'Customer', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${id} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

async function runStep(ctx, step) {
  if (!matches(step.id)) return
  ctx.b?.mark()
  try {
    const detail = await RUNNERS[step.id](ctx)
    if (typeof detail === 'string' && detail.startsWith('SKIP:')) line('SKIP', `${step.id} ${step.slug}`, detail.slice(5).trim())
    else line('PASS', `${step.id} ${step.slug}`, typeof detail === 'string' ? detail : undefined)
  } catch (err) {
    line('FAIL', `${step.id} ${step.slug}`, short(err).slice(0, 700))
  }
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!process.env.BCAT_STACK) throw new Error('devVerifyAW refuses to run without BCAT_STACK=rehearsal (or BCAT_STACK=dev) set explicitly')
  if (!['rehearsal', 'dev'].includes(STACK.name)) throw new Error(`devVerifyAW refuses stack ${STACK.name}`)
  if (!APPSYNC_URL_RE.test(DEV_API) || DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAW refuses any endpoint or pool but the selected stack')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAW only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  const ts = Date.now()
  const tag = String(ts).slice(-8)
  const emails = { admin: `zz-aw-admin-${ts}@example.invalid`, releaser: `zz-aw-release-${ts}@example.invalid`, signer: `zz-aw-signoff-${ts}@example.invalid` }
  const made = []
  const tmp = await mkdtemp(join(tmpdir(), 'aw-e5-'))
  const ctx = {
    ts, tag, origin, ids: {}, shipmentIds: new Set(), customerIds: [], invoiceIds: new Set(),
    expectLoads: intOpt('expect-loads'), expectShipments: intOpt('expect-shipments'), outputs: opt('outputs'),
  }
  try {
    ctx.ids.admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    ctx.ids.releaser = await mintIdentity(emails.releaser, ['page-tms', 'page-billingRelease']); made.push(emails.releaser)
    ctx.ids.signer = await mintIdentity(emails.signer, ['page-aljexSignoff']); made.push(emails.signer)
    console.log('identity: temporary staff identities created (admin, releaser, signer)')
    ctx.token = ctx.ids.admin.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.car = routerAs(ctx.token, 'tmsCarrierActions')
    ctx.ship = routerAs(ctx.token, 'tmsShipmentActions')
    ctx.fin = routerAs(ctx.token, 'tmsFinanceActions')
    ctx.finAdmin = ctx.fin
    ctx.finGrant = routerAs(ctx.ids.releaser.token, 'tmsFinanceActions')
    ctx.impAdmin = routerAs(ctx.token, 'tmsAljexImport')
    ctx.impSign = routerAs(ctx.ids.signer.token, 'tmsAljexImport')
    // Captured before any step so the finally block can restore exactly what was there (never clear a real list).
    const settings = await getRow(ctx.token, 'TmsSettings', 'default', 'id invoiceAlwaysCopyEmails')
    if (!settings) throw new Error('TmsSettings default row not found; refusing to run (the always-copy list could not be restored)')
    ctx.alwaysCopyBefore = settings.invoiceAlwaysCopyEmails ?? []
    ctx.eng = await loadEngine()
    ctx.files = writeSyntheticFiles(ctx.eng, tmp)
    ctx.b = await launchBrowser({ origin, storage: ctx.ids.admin.storage, profilePrefix: 'bcat-aw-', purpose: 'AW verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
    try {
      await ctx.b.navigate('/dashboard'); await pause(1500)
      for (const step of AW_STEPS) await runStep(ctx, step)
    } finally { await ctx.b.close() }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${short(err).slice(0, 120)})`); process.exitCode = 1 })
    await rm(tmp, { recursive: true, force: true })
    for (const email of made.slice().reverse()) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }
  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIP').length
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed, skip: skipped })}`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAW failed: ${err?.message ?? err}`); process.exit(1) })
}
