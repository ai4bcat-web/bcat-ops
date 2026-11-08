#!/usr/bin/env node
/**
 * Step AE verification against the DEV site: Quotes cleanup (Lane rates retired, old URL redirects to /tms/rates) and the
 * Rate intelligence panel (DAT RateView / what we ran this lane for / what we quoted this lane for) on the Spot inbox and the
 * Quote detail page, backed by the LANE_INTELLIGENCE action.
 *
 *   node scripts/devVerifyAE.mjs [--inventory] [--only=<substring>] [--no-ui]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAE.mjs
 *
 *   --inventory  no network, no browser: every AE id has a runner, LANE_INTELLIGENCE is in the shipment handler's action union /
 *                offer-actions table / switch, every data-testid the steps read exists in the source, the Lane rates page is gone from
 *                the nav and routes, the shared lib files exist.
 *   --only=      run only the steps whose id contains the substring (fixtures are still created; cleanup always runs).
 *   --no-ui      skip the browser steps (AE04).
 *
 * RUNS ONLY AFTER THE DEPLOY (AE01-AE03 call the new action). Dev only: refuses any AppSync endpoint but the dev one, any staff
 * pool but the dev pool and any origin outside ALLOWED_ORIGINS. No SSM, no main / production, no invoice_*.json, no Aljex export.
 * Nothing is ever sent: SEND_QUOTE uses via:'COPY' (mints the link, sends no mail). Passwords, tokens and customer names are never
 * printed (counts, ids and seconds only).
 *
 * Everything it creates is ZZ AE …: one customer and two quotes on a made-up lane (ZZVille<stamp>, IL → ZZburg<stamp>, TX, unique per run). In `finally` the open
 * quote is cancelled, the lost one is already closed, the customer archived, the temporary admin deleted (`identity deleted: true`).
 * AE01 only READS the real lane history (Chicago → Dallas, Van), so the 10k imported loads are never touched.
 *
 * Screenshots: Docs/tms-build/screenshots/ae/<name>.png, 1440×900, listed in index.txt.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const SHOTS = resolve('Docs/tms-build/screenshots/ae')
/** Budget for the panel's data (plan: < 2 s). */
const PANEL_BUDGET_S = 2

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const want = (id) => !only || id.includes(only)

export const AE_STEPS = [
  { id: 'AE01', slug: 'lane-intelligence-read', ui: false },
  { id: 'AE02', slug: 'quote-outcomes', ui: false },
  { id: 'AE03', slug: 'mark-lost-reason', ui: false },
  { id: 'AE04', slug: 'ui', ui: true },
  { id: 'AE05', slug: 'push-to-dat', ui: false },
  { id: 'AE06', slug: 'mark-won-win-rate', ui: false },
  { id: 'AE07', slug: 'outcome-ui', ui: true },
]

/** Router actions the harness calls: each must exist in the handler's action union (checked offline by --inventory). */
export const ACTIONS = {
  'amplify/functions/tms-shipment-actions/handler.ts': ['LANE_INTELLIGENCE', 'SAVE_QUOTE', 'SEND_QUOTE', 'MARK_QUOTE_LOST', 'MARK_QUOTE_WON', 'CANCEL_QUOTE', 'POST_QUOTE_LOAD', 'UNPOST_QUOTE_LOAD'],
  'amplify/functions/tms-directory-actions/handler.ts': ['UPSERT_CUSTOMER', 'ARCHIVE_CUSTOMER'],
}
/** data-testids the UI step reads, and the source file that must carry each. */
export const TEST_IDS = {
  'src/features/quotes/components/RateIntelligencePanel.tsx': ['rate-intel', 'rate-intel-dat', 'rate-intel-ran', 'rate-intel-quoted', 'rate-intel-stub', 'rate-intel-live', 'rate-intel-winrate'],
  'src/features/quotes/components/PushToDatCard.tsx': ['push-dat', 'push-dat-status', 'push-dat-stub', 'push-dat-live', 'push-dat-post', 'push-dat-unpost'],
  'src/features/tms/carrierSales/QuotePostingsCard.tsx': ['quote-postings'],
  'src/features/quotes/components/OutcomeBadge.tsx': ['quote-outcome'],
  'src/features/spot-quoter/SpotInboxPage.tsx': ['spot-outcome'],
  'src/features/spot-quoter/SpotRequestDrawer.tsx': ['spot-section-intel', 'spot-lost-code', 'spot-section-push-dat', 'spot-mark-won', 'spot-mark-lost', 'spot-request-outcome', 'spot-copy', 'spot-open-compose', 'spot-mark-sent'],
}
const PLAN_FILES = [
  'src/lib/laneMatch.ts', 'src/lib/laneIntel.ts', 'src/lib/retiredRoutes.ts', 'src/components/ParamRedirect.tsx',
  'src/features/quotes/components/RateIntelligencePanel.tsx', 'src/features/quotes/components/PushToDatCard.tsx',
  'src/features/tms/carrierSales/QuotePostingsCard.tsx', 'amplify/functions/tms-shipment-actions/laneIntel.ts',
]

const results = []
const record = (status, id, detail = '') => {
  results.push({ status, id, detail })
  console.log(`${status.padEnd(4)} ${id}${detail ? `  ${detail}` : ''}`)
}
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200)
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const exists = (file) => access(resolve(file)).then(() => true, () => false)
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const tid = (id) => `[data-testid="${id}"]`

// ───────────────────────────── inventory (no network, no browser) ─────────────────────────────
export async function inventory() {
  let ok = true
  const check = (pass, id, detail) => { record(pass ? 'PASS' : 'FAIL', id, detail); if (!pass) ok = false }

  const runners = Object.keys(RUNNERS)
  const ids = AE_STEPS.map((s) => s.id)
  const disagree = ids.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !ids.includes(id)))
  check(disagree.length === 0, 'AE00 gate 1: AE ids registered', disagree.length ? `registry and runners disagree on: ${disagree.join(', ')}` : `${ids.length} steps each have a runner`)

  const missingFiles = []
  for (const file of PLAN_FILES) if (!(await exists(file))) missingFiles.push(file)
  check(missingFiles.length === 0, 'AE00 gate 2: plan files exist', missingFiles.length ? `missing: ${missingFiles.join(', ')}` : `${PLAN_FILES.length} files`)

  for (const [file, actions] of Object.entries(ACTIONS)) {
    const text = await readFile(file, 'utf8').catch(() => null)
    const missing = text == null ? actions : actions.filter((a) => !new RegExp(`['"]${a}['"]`).test(text))
    check(missing.length === 0, `AE00 gate 3: actions in ${file.split('/').slice(-2)[0]}`, missing.length ? `missing: ${missing.join(', ')}` : actions.join(', '))
  }
  const handler = await readFile('amplify/functions/tms-shipment-actions/handler.ts', 'utf8').catch(() => '')
  check(/LANE_INTELLIGENCE: true/.test(handler) && /case 'LANE_INTELLIGENCE'/.test(handler), 'AE00 gate 4: LANE_INTELLIGENCE is authorised and routed', 'OFFER_ACTIONS entry + switch case')
  check(/POST_QUOTE_LOAD: true/.test(handler) && /UNPOST_QUOTE_LOAD: true/.test(handler) && /case 'POST_QUOTE_LOAD'/.test(handler) && /case 'UNPOST_QUOTE_LOAD'/.test(handler), 'AE00 gate 4b: Push to DAT actions are authorised and routed', 'OFFER_ACTIONS entries + switch cases')
  const carrierSales = await readFile('src/features/tms/carrierSales/CarrierSalesPage.tsx', 'utf8').catch(() => '')
  check(/<QuotePostingsCard \/>/.test(carrierSales), 'AE00 gate 4c: Carrier Sales lists quote postings', 'QuotePostingsCard rendered')

  for (const [file, idsIn] of Object.entries(TEST_IDS)) {
    const text = await readFile(file, 'utf8').catch(() => '')
    const missing = idsIn.filter((id) => !text.includes(`"${id}"`))
    check(missing.length === 0, `AE00 gate 5: data-testids in ${file.split('/').pop()}`, missing.length ? `missing: ${missing.join(', ')}` : idsIn.join(', '))
  }

  const nav = await readFile('src/lib/navSections.ts', 'utf8').catch(() => '')
  check(!/Lane rates/.test(nav) && !/\/tms\/rates\/lanes/.test(nav), 'AE00 gate 6: Lane rates is out of the nav', 'no label or route in navSections.ts')
  const retired = await readFile('src/lib/retiredRoutes.ts', 'utf8').catch(() => '')
  check(/\/tms\/rates\/lanes[^}]*\/tms\/rates'/.test(retired), 'AE00 gate 7: old Lane rates URL redirects', '/tms/rates/lanes → /tms/rates')
  const app = await readFile('src/App.tsx', 'utf8').catch(() => '')
  check(!/LaneRatesPage/.test(app) && /RETIRED_ROUTES/.test(app), 'AE00 gate 8: the Lane rates page is not routed', 'App.tsx mounts RETIRED_ROUTES, not LaneRatesPage')
  check(!(await exists('src/features/quotes/LaneRatesPage.tsx')), 'AE00 gate 9: Lane rates page code is deleted', 'LaneRatesPage.tsx is gone')

  // Read-only mailbox: no send / draft / compose / modify scope or Gmail write call anywhere in app or Lambda source (tests excluded: they assert the absence).
  const FORBIDDEN = /auth\/gmail\.(?!readonly)|gmail\.(send|compose|modify|insert|labels)\b|messages\.send|drafts\.(create|send|update)|\b(sendDraft|createDraft|updateDraft|sendReply)\(|data-testid="spot-(create-draft|send-now|update-draft|autosend)/
  const hits = []
  const walk = async (dir) => {
    for (const e of await readdir(resolve(dir), { withFileTypes: true }).catch(() => [])) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) await walk(rel) }
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) { if (FORBIDDEN.test(await readFile(resolve(rel), 'utf8'))) hits.push(rel) }
    }
  }
  await walk('src'); await walk('amplify')
  check(hits.length === 0, 'AE00 gate 10: Gmail is read-only (no send/draft/compose/modify scope or call)', hits.length ? `found in: ${hits.join(', ')}` : 'src/ and amplify/ source scanned')
  const oauth = await readFile('amplify/functions/_shared/gmail/oauth.ts', 'utf8').catch(() => '')
  check(/REQUIRED_GMAIL_SCOPES = \['https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly'\]/.test(oauth), 'AE00 gate 11: the OAuth scope list is gmail.readonly only', 'REQUIRED_GMAIL_SCOPES')
  const outcomeSrc = await readFile('src/lib/laneIntel.ts', 'utf8').catch(() => '')
  check(/quote\.shipmentId \|\| quote\.status === 'WON'\) return 'WON'/.test(outcomeSrc), 'AE00 gate 12: a converted quote is WON automatically', 'quoteOutcome reads shipmentId')
  return ok
}

// ───────────────────────────── helpers ─────────────────────────────
/** Unique per run (the stamp is in the city names), so earlier runs' quotes never count and totals are exact. */
const zzCity = (ts, kind) => `ZZ${kind}${ts}`
const zzLane = (ts) => ({
  originCity: zzCity(ts, 'Ville'), originState: 'IL', originZip: '', destinationCity: zzCity(ts, 'burg'), destinationState: 'TX', destinationZip: '', equipmentType: 'VAN',
})

const quoteBody = (ctx, ts, n) => ({
  customerId: ctx.customerId, mode: 'FTL', rateType: 'SPOT', equipmentType: 'VAN', commodity: 'General freight', miles: 925, weightLbs: 40000,
  contactName: 'ZZ AE Buyer', contactEmail: `zz-ae-${ts}@example.invalid`,
  stops: [
    { type: 'pickup', name: 'ZZ AE Shipper', city: `${zzCity(ts, 'Ville')}, IL`, address: { city: zzCity(ts, 'Ville'), state: 'IL', zip: '' }, appt: `${day(3)}T15:00:00.000Z` },
    { type: 'delivery', name: 'ZZ AE Receiver', city: `${zzCity(ts, 'burg')}, TX`, address: { city: zzCity(ts, 'burg'), state: 'TX', zip: '' }, appt: `${day(4)}T18:00:00.000Z` },
  ],
  lines: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000 + n * 10000, count: 1 }, { side: 'CARRIER', code: 'LINEHAUL', rateCents: 200000, count: 1 }],
})

async function newQuote(ctx, n) {
  const saved = await ctx.ship('SAVE_QUOTE', quoteBody(ctx, ctx.ts, n))
  const quoteId = String(saved.quote.id)
  ctx.quoteIds.add(quoteId)
  await ctx.ship('SEND_QUOTE', { quoteId, via: 'COPY', message: 'ZZ AE verification', to: [`zz-ae-${ctx.ts}@example.invalid`] })
  return quoteId
}

async function ensureFixture(ctx) {
  if (ctx.quoteA) return
  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: `ZZ AE Customer ${ctx.ts}`, creditLimitCents: 100_000_000,
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AE Contact', email: `zz-ae-${ctx.ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `bt-${randomUUID()}`, name: 'ZZ AE Bill To', isDefault: true }],
  })
  ctx.customerId = String((customer.customer ?? customer).id)
  ctx.quoteA = await newQuote(ctx, 0)
  ctx.quoteB = await newQuote(ctx, 1)
}

// ───────────────────────────── steps ─────────────────────────────
async function ae01(ctx) {
  const real = { originCity: 'Chicago', originState: 'IL', originZip: '60601', destinationCity: 'Dallas', destinationState: 'TX', destinationZip: '75201', equipmentType: 'VAN' }
  const t0 = Date.now()
  const out = await ctx.ship('LANE_INTELLIGENCE', real)
  const cold = (Date.now() - t0) / 1000
  expect(out && out.runs && out.quotes, 'LANE_INTELLIGENCE answered without runs / quotes')
  expect(out.laneKey === 'CHICAGO|IL>DALLAS|TX' && out.laneKey3 === '606>752', `lane keys ${out.laneKey} / ${out.laneKey3}`)
  expect(out.months === 24 && /^\d{4}-\d{2}-\d{2}$/.test(out.fromDate), `window ${out.months} months from ${out.fromDate}`)
  const t1 = Date.now()
  await ctx.ship('LANE_INTELLIGENCE', real)
  const warm = (Date.now() - t1) / 1000
  expect(cold <= PANEL_BUDGET_S, `cold ${cold.toFixed(2)} s over the ${PANEL_BUDGET_S} s budget`)
  const { stats } = out.runs
  return `ran ${stats.count} loads (rows ${out.runs.rows.length}, truncated ${out.truncated}); quoted ${out.quotes.stats.count}, win rate ${out.quotes.stats.winRate == null ? 'n/a' : Math.round(out.quotes.stats.winRate * 100) + ' %'}; cold ${cold.toFixed(2)} s, warm ${warm.toFixed(2)} s (budget ${PANEL_BUDGET_S} s)`
}

async function ae02(ctx) {
  await ensureFixture(ctx)
  // Lose A first, then read the lane once: the action caches an answer for a minute.
  await ctx.ship('MARK_QUOTE_LOST', { quoteId: ctx.quoteA, reason: 'TOO_HIGH', note: 'ZZ AE verification' })
  const out = await ctx.ship('LANE_INTELLIGENCE', zzLane(ctx.ts))
  const { stats, rows } = out.quotes
  expect(stats.count === 2, `expected 2 quotes on the ZZ lane, got ${stats.count}`)
  expect(stats.lost === 1 && stats.pending === 1 && stats.won === 0, `outcomes lost ${stats.lost} / pending ${stats.pending} / won ${stats.won}`)
  expect(stats.winRate === 0, `win rate ${stats.winRate}`)
  const a = rows.find((r) => r.id === ctx.quoteA)
  const b = rows.find((r) => r.id === ctx.quoteB)
  expect(a?.outcome === 'LOST' && a.lostReason === 'TOO_HIGH', `quote A outcome ${a?.outcome}/${a?.lostReason}`)
  expect(b?.outcome === 'PENDING', `quote B outcome ${b?.outcome}`)
  const excluded = await ctx.ship('LANE_INTELLIGENCE', { ...zzLane(ctx.ts), excludeQuoteId: ctx.quoteB })
  expect(excluded.quotes.rows.every((r) => r.id !== ctx.quoteB), 'excludeQuoteId still lists the quote it was told to leave out')
  expect(out.runs.stats.count === 0, `the ZZ lane has ${out.runs.stats.count} imported loads`)
  return `LOST (TOO_HIGH) + PENDING recorded, win rate 0 %, excludeQuoteId honoured, no loads on the ZZ lane`
}

async function ae03(ctx) {
  await ensureFixture(ctx)
  const row = (await gql(ctx.token, `query { getQuote(id: ${JSON.stringify(ctx.quoteA)}) { id status lostReason lostNote closedAt } }`, {})).getQuote
  expect(row.status === 'LOST' && row.lostReason === 'TOO_HIGH' && row.lostNote === 'ZZ AE verification' && row.closedAt, `quote A is ${row.status}/${row.lostReason}/${row.lostNote ? 'note' : 'no note'}/${row.closedAt ? 'closed' : 'open'}`)
  let refused = false
  try { await ctx.ship('MARK_QUOTE_LOST', { quoteId: ctx.quoteB, reason: 'NOT_A_REASON' }) } catch { refused = true }
  expect(refused, 'MARK_QUOTE_LOST accepted a reason outside the enum')
  return 'Mark lost stores the coded reason, the note and closedAt; an invalid reason is refused'
}

async function ae04(ctx) {
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`origin ${origin} is not in ALLOWED_ORIGINS`)
  await ensureFixture(ctx)
  await mkdir(SHOTS, { recursive: true })
  const shots = []
  const b = await launchBrowser({ origin, storage: ctx.storage, profilePrefix: 'bcat-ae-', purpose: 'AE verification', viewport: { width: 1440, height: 900 } })
  try {
    // 1. the old URL lands on Quotes, and the nav has no Lane rates row
    await b.navigate('/tms/rates/lanes?x=1')
    await b.waitFor('[data-testid="lifecycle-tab-quote"]', 60_000)
    await b.evaluate('new Promise((r) => setTimeout(r, 1500))')
    const path = await b.evaluate('location.pathname + location.search')
    expect(path.startsWith('/tms/rates') && !path.includes('lanes'), `old Lane rates URL landed on ${path}`)
    const labels = await b.evaluate(`[...document.querySelectorAll('.tms-nav-child-label, .tms-nav-label, .tms-lifecycle-label, .tms-lifecycle-caption')].map((n) => n.textContent.trim())`)
    expect(!labels.includes('Lane rates'), 'the nav still lists Lane rates')
    await b.screenshot(`${SHOTS}/AE01-quotes-after-redirect.png`); shots.push('AE01-quotes-after-redirect.png')

    // 2. Quote detail carries the panel with its three sections
    await b.navigate(`/tms/rates/${ctx.quoteB}`)
    await b.waitFor(tid('rate-intel'), 60_000)
    await b.waitFor(tid('rate-intel-quoted-table'), 30_000)
    const sections = await b.evaluate(`['rate-intel-dat','rate-intel-ran','rate-intel-quoted'].map((id) => !!document.querySelector('[data-testid="' + id + '"]'))`)
    expect(sections.every(Boolean), `panel sections present: ${JSON.stringify(sections)}`)
    const badge = await b.evaluate(`!!document.querySelector('[data-testid="rate-intel-stub"]') ? 'STUB' : !!document.querySelector('[data-testid="rate-intel-live"]') ? 'LIVE' : 'none'`)
    expect(badge !== 'none', 'the DAT section shows neither LIVE nor STUB')
    const outcomes = await b.evaluate(`[...document.querySelectorAll('[data-testid="rate-intel-quoted-table"] .tms-badge')].map((n) => n.textContent.trim())`)
    expect(outcomes.includes('LOST'), `the lane's quoted table lists ${outcomes.join(', ') || 'nothing'} (expected LOST for the other ZZ quote)`)
    await b.screenshot(`${SHOTS}/AE02-quote-detail-rate-intelligence.png`, { clipToContent: true }); shots.push('AE02-quote-detail-rate-intelligence.png')

    // 3. Spot inbox: open the newest request, if any, and look for the panel
    await b.navigate('/tms/rates/spot')
    await b.evaluate('new Promise((r) => setTimeout(r, 2500))')
    const opened = await b.evaluate(`(() => { const row = document.querySelector('[data-testid^="spot-row"], .tms-spot-row, tbody tr'); if (!row) return false; row.click(); return true })()`)
    let spot = 'no spot request on dev to open (panel proven on the quote page)'
    if (opened) {
      await b.waitFor(tid('spot-section-intel'), 30_000).then(async () => {
        await b.waitFor(tid('rate-intel-dat'), 30_000)
        await b.screenshot(`${SHOTS}/AE03-spot-inbox-rate-intelligence.png`); shots.push('AE03-spot-inbox-rate-intelligence.png')
        spot = 'spot request shows the panel'
      }).catch(() => { spot = 'a row opened but showed no Rate intelligence section' })
      expect(spot === 'spot request shows the panel', spot)
    }
    return `old URL → ${path}; nav has no Lane rates; quote page: 3 sections, DAT ${badge}, outcomes ${outcomes.join('/')}; ${spot}; shots ${shots.join(', ')}`
  } finally {
    await b.close()
    await writeFile(resolve(SHOTS, 'index.txt'), `${shots.join('\n')}\n`)
  }
}

async function ae05(ctx) {
  await ensureFixture(ctx)
  const spot = routerAs(ctx.token, 'tmsSpotActions')
  const status = await spot('SPOT_STATUS', {}).catch(() => null)
  if (status?.datProvider?.mode === 'LIVE') return 'SKIPPED the post: DAT is LIVE on this stack and the harness never posts a ZZ load to a real board'
  const posted = await ctx.ship('POST_QUOTE_LOAD', { quoteId: ctx.quoteB })
  const row = posted.postings?.[0]
  expect(row && row.status === 'POSTED' && row.mode === 'STUB' && /STUB/.test(String(row.message)), `posting ${row?.status}/${row?.mode}/${String(row?.message).slice(0, 40)}`)
  expect(row.shipmentId === `quote:${ctx.quoteB}` && String(row.originCity).toUpperCase() === zzCity(ctx.ts, 'Ville').toUpperCase() && row.destinationState === 'TX', `posting subject/lane ${row.shipmentId}/${row.originCity}/${row.destinationState}`)
  const read = (await gql(ctx.token, `query { listShipmentPostingByShipmentId(shipmentId: ${JSON.stringify(`quote:${ctx.quoteB}`)}) { items { id status mode } } }`, {})).listShipmentPostingByShipmentId.items
  expect(read.length === 1 && read[0].status === 'POSTED', `recorded rows ${read.length}`)
  const down = await ctx.ship('UNPOST_QUOTE_LOAD', { quoteId: ctx.quoteB })
  expect(down.postings?.[0]?.status === 'UNPOSTED', `unpost answered ${down.postings?.[0]?.status}`)
  return 'STUB posting recorded against quote:<id> with the lane, read back POSTED, then UNPOSTED (row kept); no Shipment touched'
}

async function ae06(ctx) {
  await ensureFixture(ctx)
  // A third quote on the ZZ lane, won by hand (no shipment): the lane's win rate must read 1 won / 1 lost (A) / 1 pending (B).
  const quoteC = await newQuote(ctx, 2)
  ctx.quoteC = quoteC
  const won = (await ctx.ship('MARK_QUOTE_WON', { quoteId: quoteC, note: 'ZZ AE verification' })).quote
  expect(won.status === 'WON' && won.wonAt && won.closedAt, `quote C is ${won.status}`)
  expect(!won.shipmentId, 'Mark won built a shipment')
  let refused = false
  try { await ctx.ship('MARK_QUOTE_WON', { quoteId: quoteC }) } catch { refused = true }
  expect(refused, 'a second Mark won was accepted')
  await new Promise((r) => setTimeout(r, 61_000)) // LANE_INTELLIGENCE caches an answer for a minute
  const out = await ctx.ship('LANE_INTELLIGENCE', zzLane(ctx.ts))
  const { stats, rows } = out.quotes
  expect(stats.won === 1 && stats.lost === 1 && stats.pending === 1, `outcomes won ${stats.won} / lost ${stats.lost} / pending ${stats.pending}`)
  expect(stats.winRate === 0.5, `win rate ${stats.winRate}`)
  expect(rows.find((r) => r.id === quoteC)?.outcome === 'WON', 'quote C is not WON in the lane history')
  return 'Mark won (by hand, no shipment) → WON with wonAt/closedAt; second close refused; lane win rate 50 % (1 won / 1 lost / 1 pending)'
}

async function ae07(ctx) {
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`origin ${origin} is not in ALLOWED_ORIGINS`)
  await ensureFixture(ctx)
  await mkdir(SHOTS, { recursive: true })
  const shots = []
  const b = await launchBrowser({ origin, storage: ctx.storage, profilePrefix: 'bcat-ae-', purpose: 'AE outcome verification', viewport: { width: 1440, height: 900 } })
  const sleep = (ms) => b.evaluate(`new Promise((r) => setTimeout(r, ${ms}))`)
  const click = (label) => b.evaluate(`(() => { const n = [...document.querySelectorAll('button, [role="tab"]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!n) return false; n.click(); return true })()`)
  try {
    // 1. Quotes › Sent: an Outcome column, a filter chip + dialog
    await b.navigate('/tms/rates')
    await b.waitFor('[data-testid="lifecycle-tab-quote"]', 60_000)
    await sleep(2500)
    expect(await click('Sent'), 'no Sent tab')
    await sleep(800)
    const header = await b.evaluate(`[...document.querySelectorAll('th')].map((n) => n.textContent.trim().toUpperCase())`)
    expect(header.includes('OUTCOME'), `Sent tab columns: ${header.join('|')}`)
    const chip = await b.evaluate(`document.body.innerText.includes('Outcome is')`)
    expect(chip, 'the Sent tab has no Outcome filter chip')
    const pending = await b.evaluate(`[...document.querySelectorAll('[data-testid="quote-outcome"]')].map((n) => n.textContent.trim())`)
    expect(pending.includes('Pending'), `Sent outcomes: ${[...new Set(pending)].join(',') || 'none'}`)
    await b.screenshot(`${SHOTS}/AE04-quotes-sent-outcome-column.png`); shots.push('AE04-quotes-sent-outcome-column.png')
    expect(await click('Won / Lost'), 'no Won / Lost tab')
    await sleep(2500)
    await b.screenshot(`${SHOTS}/AE05-quotes-won-lost-outcome.png`); shots.push('AE05-quotes-won-lost-outcome.png')

    // 2. Quote detail: outcome in the header, Mark won / Mark lost on an open quote
    await b.navigate(`/tms/rates/${ctx.quoteB}`)
    await b.waitFor(tid('rate-intel'), 60_000)
    const head = await b.evaluate(`document.querySelector('[data-testid="quote-outcome"]')?.textContent.trim() ?? null`)
    expect(head === 'Pending', `Quote detail header outcome ${head}`)
    const btns = await b.evaluate(`['Mark the quote won', 'Mark the quote lost'].map((l) => !!document.querySelector('button[aria-label="' + l + '"]'))`)
    expect(btns.every(Boolean), `Mark won / Mark lost buttons: ${JSON.stringify(btns)}`)
    await b.waitFor(tid('rate-intel-quoted-table'), 30_000)
    const wr = await b.evaluate(`document.querySelector('[data-testid="rate-intel-winrate"]')?.textContent.trim() ?? null`)
    expect(wr, 'the quoted section shows no win rate')
    await b.screenshot(`${SHOTS}/AE06-quote-detail-outcome-actions.png`, { clipToContent: true }); shots.push('AE06-quote-detail-outcome-actions.png')

    // 3. Won quote C reads Won with no verbs left
    if (ctx.quoteC) {
      await b.navigate(`/tms/rates/${ctx.quoteC}`)
      await b.waitFor(tid('rate-intel'), 60_000)
      const won = await b.evaluate(`document.querySelector('[data-testid="quote-outcome"]')?.textContent.trim() ?? null`)
      expect(won === 'Won', `won quote header outcome ${won}`)
      expect(await b.evaluate(`!document.querySelector('button[aria-label="Mark the quote won"]') && !document.querySelector('button[aria-label="Mark the quote lost"]')`), 'a won quote still offers Mark won / Mark lost')
    }

    // 4. Spot inbox: an Outcome column when requests exist; the drawer carries Mark won / Mark lost once sent
    await b.navigate('/tms/rates/spot')
    await sleep(2500)
    const spotCols = await b.evaluate(`[...document.querySelectorAll('th')].map((n) => n.textContent.trim().toUpperCase())`)
    const hasRows = await b.evaluate(`document.querySelectorAll('tbody tr').length`)
    if (hasRows > 0) {
      expect(spotCols.includes('OUTCOME'), `Spot inbox columns: ${spotCols.join('|')}`)
      await b.screenshot(`${SHOTS}/AE07-spot-inbox-outcome.png`); shots.push('AE07-spot-inbox-outcome.png')
    }
    // 5. Carrier Sales still lists quote postings (outcome beside each) — the card only renders when something is posted
    return `Sent tab: OUTCOME column + chip (${[...new Set(pending)].join('/')}); detail header ${head}, Mark won / Mark lost present, win rate shown; won quote reads Won${ctx.quoteC ? '' : ' (skipped: AE06 not run)'}; spot inbox ${hasRows > 0 ? 'Outcome column present' : 'has no requests on dev (outcome asserted in unit tests)'}; shots ${shots.join(', ')}`
  } finally {
    await b.close()
    await writeFile(resolve(SHOTS, 'index-outcome.txt'), `${shots.join('\n')}\n`)
  }
}

export const RUNNERS = { AE01: ae01, AE02: ae02, AE03: ae03, AE04: ae04, AE05: ae05, AE06: ae06, AE07: ae07 }

async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAE refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAE refuses any staff pool other than the dev pool')
  const ts = Date.now()
  const email = `zz-ae-${ts}@example.invalid`
  let made = false
  const ctx = { ts, token: '', storage: null, customerId: null, quoteA: null, quoteB: null, quoteC: null, quoteIds: new Set(), ship: null, dir: null }
  try {
    const admin = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary admin created')
    ctx.token = admin.token
    ctx.storage = admin.storage
    ctx.ship = routerAs(admin.token, 'tmsShipmentActions')
    ctx.dir = routerAs(admin.token, 'tmsDirectoryActions')
    for (const step of AE_STEPS) {
      if (!want(step.id) || (step.ui && flag('no-ui'))) continue
      try { record('PASS', `${step.id} ${step.slug}`, await RUNNERS[step.id](ctx)) } catch (err) { record('FAIL', `${step.id} ${step.slug}`, short(err)) }
    }
  } finally {
    if (ctx.token) {
      for (const id of ctx.quoteIds) {
        try {
          const row = (await gql(ctx.token, `query { getQuote(id: ${JSON.stringify(id)}) { id status } }`, {})).getQuote
          if (row && !['WON', 'LOST', 'PASS', 'CANCELED'].includes(row.status)) await ctx.ship('CANCEL_QUOTE', { quoteId: id, reason: 'step AE verification fixture' })
          console.log(`cleanup: quote ${id} closed`)
        } catch (err) { console.log(`cleanup: quote ${id} failed: ${short(err)}`); process.exitCode = 1 }
      }
      if (ctx.customerId) {
        try {
          const row = (await gql(ctx.token, `query { getCustomer(id: ${JSON.stringify(ctx.customerId)}) { id updatedAt } }`, {})).getCustomer
          if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) })
          console.log('cleanup: ZZ customer archived')
        } catch (err) { console.log(`cleanup: ZZ customer archive failed: ${short(err)}`); process.exitCode = 1 }
      }
    }
    if (made) console.log(`identity deleted: ${await deleteIdentity(email)}`)
  }
  const failed = results.filter((r) => r.status === 'FAIL')
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAE failed: ${short(err)}`); process.exit(1) })
}
