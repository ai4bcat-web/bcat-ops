/**
 * Step PERF API gates (PERF-plan.md §11.2 G1, G2, G7): the app's REAL loaders (src/lib/boardData.ts, apiClient.ts) against the
 * DEV API, compared with independent raw reads (scripts/lib/perfExpected.mjs). Read-only.
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/devVerifyPerfApi.mts [--only=G1|G2|G7]
 *
 * Dev only: devIdentity points at the dev pool / AppSync; a throwaway admin is minted and deleted in `finally`
 * (`identity deleted: true`). The identity is minted BEFORE the app modules are imported so Amplify is configured when
 * apiClient creates its client. `fetch` is wrapped to count AppSync round trips and response bytes per measurement.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql } from './lib/devIdentity.mjs'
import { LOADER_BUDGETS, SCALE } from './lib/perfBudgets.mjs'
import { fullScan, activeIdsOf, monthIdsOf, pageAll, trackingRows } from './lib/perfExpected.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
const want = (gate: string) => !only || only === gate

let failed = 0
const out = (status: 'PASS' | 'FAIL', id: string, detail = '') => {
  if (status === 'FAIL') failed += 1
  console.log(`${status.padEnd(4)} ${id}${detail ? `  ${detail}` : ''}`)
}

// ───────────────────────────── fetch accounting ─────────────────────────────
const realFetch = globalThis.fetch.bind(globalThis)
let trips = 0
let bytes = 0
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const res = await realFetch(input, init)
  if (url.includes('appsync-api.')) {
    trips += 1
    res.clone().arrayBuffer().then((b) => { bytes += b.byteLength }, () => {})
  }
  return res
}) as typeof fetch

async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; seconds: number; trips: number; mb: number }> {
  const t0 = performance.now()
  const trips0 = trips
  const bytes0 = bytes
  const value = await fn()
  await new Promise((r) => setTimeout(r, 50)) // let the last clone() byte counts land
  return { value, seconds: (performance.now() - t0) / 1000, trips: trips - trips0, mb: (bytes - bytes0) / 1e6 }
}

const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x))
const first10 = (ids: string[]) => ids.slice(0, 10).join(', ')

async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyPerfApi refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyPerfApi refuses any staff pool other than the dev pool')
  const email = `zz-perfapi-${Date.now()}@example.invalid`
  let made = false
  try {
    const admin = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary admin created')
    const token = admin.token

    const board = await import('../src/lib/boardData.ts')
    const api = await import('../src/lib/apiClient.ts')
    const windows = await import('../src/lib/shipmentWindows.ts')
    const lists = await import('../src/lib/shipmentLists.ts')

    const month = windows.currentMonth(new Date())
    /** `month` and the n months before it ('YYYY-MM', sorted). */
    const monthsBack = (n: number) => {
      const [y, m] = month.split('-').map(Number)
      return Array.from({ length: n + 1 }, (_, i) => {
        const idx = y * 12 + (m - 1) - (n - i)
        return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
      })
    }

    // ── G2 loader budgets (cold: this process has empty caches) + G7 ──
    let workingBundle: Awaited<ReturnType<typeof board.loadBoardBundle>> | null = null
    const g2 = (id: string, m: { seconds: number; trips: number; mb: number }, budget: Record<string, number>, extra = '') => {
      const bad: string[] = []
      if (budget.seconds != null && m.seconds > budget.seconds) bad.push(`${m.seconds.toFixed(1)} s > ${budget.seconds}`)
      if (budget.trips != null && m.trips > budget.trips) bad.push(`${m.trips} trips > ${budget.trips}`)
      if (budget.mb != null && m.mb > budget.mb) bad.push(`${m.mb.toFixed(1)} MB > ${budget.mb}`)
      out(bad.length ? 'FAIL' : 'PASS', `G2 ${id}`, `${m.seconds.toFixed(2)} s, ${m.trips} trips, ${m.mb.toFixed(2)} MB${extra ? `, ${extra}` : ''}${bad.length ? `  OVER: ${bad.join('; ')}` : ''}`)
    }
    if (want('G2') || want('G7')) {
      let firstPartial: number | null = null
      const t0 = performance.now()
      const m = await measure(() => board.loadBoardBundle({ kind: 'working' }, {
        force: true,
        onPartial: () => { if (firstPartial == null) firstPartial = (performance.now() - t0) / 1000 },
      }))
      workingBundle = m.value
      const budget = LOADER_BUDGETS.working
      g2('working', m, budget, `first partial ${firstPartial == null ? 'never' : `${firstPartial.toFixed(2)} s`}, ${m.value.shipments.length} shipments`)
      if (firstPartial == null || firstPartial > budget.firstPartial) out('FAIL', 'G2 working first partial', `${firstPartial == null ? 'onPartial never fired' : `${firstPartial.toFixed(2)} s > ${budget.firstPartial}`}`)
      else out('PASS', 'G2 working first partial', `${firstPartial.toFixed(2)} s <= ${budget.firstPartial}`)

      const stage2 = board.boardStats.stage2Ids
      out(stage2 <= SCALE.stage2Ids ? 'PASS' : 'FAIL', 'G7 stage-2 id count', `${stage2} <= ${SCALE.stage2Ids}${stage2 > SCALE.stage2Ids ? '  -> open D-P3 (sparse Shipment.workOpen)' : ''}`)
      out(m.seconds <= SCALE.workingSeconds ? 'PASS' : 'FAIL', 'G7 working total', `${m.seconds.toFixed(2)} s <= ${SCALE.workingSeconds}${m.seconds > SCALE.workingSeconds ? '  -> open D-P3' : ''}`)

      const w1 = await measure(() => board.loadBoardBundle({ kind: 'window', months: [month] }, { force: true }))
      g2('window:1', w1, LOADER_BUDGETS['window:1'], `${w1.value.shipments.length} shipments`)
      const months3 = monthsBack(2)
      const w3 = await measure(() => board.loadBoardBundle({ kind: 'window', months: months3 }, { force: true }))
      g2('window:3', w3, LOADER_BUDGETS['window:3'], `${w3.value.shipments.length} shipments (${months3.join(',')})`)

      // G7: the window request count must not depend on table size: pinned to the first recorded dev count (+10%).
      const ref = resolve('Docs/tms-build/perf/scale-reference.json')
      const recorded = JSON.parse(await readFile(ref, 'utf8').catch(() => 'null')) as { window3Trips?: number; window3Shipments?: number } | null
      if (!recorded) {
        await mkdir(resolve('Docs/tms-build/perf'), { recursive: true })
        await writeFile(ref, `${JSON.stringify({ recordedAt: new Date().toISOString(), months: months3, window3Trips: w3.trips, window3Shipments: w3.value.shipments.length }, null, 2)}\n`)
        out('PASS', 'G7 window:3 request count', `recorded ${w3.trips} trips for ${w3.value.shipments.length} shipments (first run)`)
      } else {
        // Trips scale with ROWS in the window, never with the table: allow the recorded ratio of trips to rows plus a fixed slack.
        const allowed = Math.ceil((recorded.window3Trips ?? 0) * 1.1) + Math.ceil(Math.max(0, w3.value.shipments.length - (recorded.window3Shipments ?? 0)) / 100) * 4
        out(w3.trips <= allowed ? 'PASS' : 'FAIL', 'G7 window:3 request count', `${w3.trips} <= ${allowed} (recorded ${recorded.window3Trips} for ${recorded.window3Shipments} shipments)`)
      }

      for (const name of ['customers', 'locations', 'carriers', 'userProfiles'] as const) {
        const fn = { customers: () => api.listCustomers({ includeArchived: true }), locations: () => api.listLocations({ includeArchived: true }), carriers: () => api.listCarriers(), userProfiles: () => api.listUserProfiles() }[name]
        const d = await measure(fn as () => Promise<unknown[]>)
        g2(`directory:${name}`, d, LOADER_BUDGETS[`directory:${name}`], `${d.value.length} rows`)
      }
    }

    // ── G1 equivalence (the reference model is raw reads, no app code) ──
    if (want('G1')) {
      const scan = await fullScan(token)
      const refActive = activeIdsOf(scan)
      const bundle = workingBundle ?? await board.loadBoardBundle({ kind: 'working' })
      const orderOf = new Map(bundle.orders.map((o) => [o.shipmentId, o]))
      const rowOf = (s: (typeof bundle.shipments)[number]) => {
        const o = orderOf.get(s.id)
        return { ...s, readyToInvoiceAt: o?.readyToInvoiceAt ?? null, invoiceId: o?.invoiceId ?? null, arStatus: o?.arStatus ?? null }
      }
      const workingIds = new Set(bundle.shipments.map((s) => s.id))
      const appActive = new Set(bundle.shipments
        .filter((s) => !s.voidedAt && !s.deletedAt && lists.inShipmentList(rowOf(s) as never, 'active'))
        .map((s) => s.id))
      const missing = diff(refActive, workingIds)
      const extra = diff(appActive, refActive)
      const missingActive = diff(refActive, appActive)
      const nullArStatus = missing.filter((id) => !orderOf.has(id) || orderOf.get(id)?.arStatus == null)
      out(missing.length === 0 ? 'PASS' : 'FAIL', 'G1 working set ⊇ full-scan Active', missing.length ? `${missing.length} missing, first: ${first10(missing)}${nullArStatus.length ? `; class null-arStatus: ${nullArStatus.length}` : ''}` : `${refActive.size} Active ids all present (working set ${workingIds.size})`)
      out(extra.length === 0 && missingActive.length === 0 ? 'PASS' : 'FAIL', 'G1 Active after inShipmentList == full-scan Active', `extra ${extra.length}${extra.length ? ` (${first10(extra)})` : ''}, missing ${missingActive.length}${missingActive.length ? ` (${first10(missingActive)})` : ''}`)

      const win = await board.loadBoardBundle({ kind: 'window', months: [month] }, { force: true })
      const appMonth = new Set(win.shipments.filter((s) => s.pickupMonth === month && !s.voidedAt && !s.deletedAt).map((s) => s.id))
      const refMonth = monthIdsOf(scan, month)
      const mExtra = diff(appMonth, refMonth)
      const mMissing = diff(refMonth, appMonth)
      out(mExtra.length === 0 && mMissing.length === 0 ? 'PASS' : 'FAIL', `G1 server-filtered month ${month} == full-scan client-filtered`, `${appMonth.size} vs ${refMonth.size}${mExtra.length ? `; extra ${first10(mExtra)}` : ''}${mMissing.length ? `; missing ${first10(mMissing)} (class: NULL-typed voidedAt or pickupMonth null)` : ''}`)

      // Tracking: rate-con-sent ACTIVE legs on live shipments, derived from the working bundle vs the independent leg scan.
      const refTracking = new Set(await trackingRows(token))
      const live = new Map(bundle.shipments.filter((s) => !s.voidedAt && !s.deletedAt && s.status !== 'DELIVERED' && s.status !== 'CANCELED').map((s) => [s.id, s]))
      const appTracking = new Set(bundle.loadCarriers
        .filter((c) => c.status === 'ACTIVE' && ['SENT', 'OPENED', 'SIGNED'].includes(String(c.rateConStatus)) && live.has(c.shipmentId))
        .map((c) => c.shipmentId))
      const tMissing = diff(refTracking, appTracking)
      const tExtra = diff(appTracking, refTracking)
      out(tMissing.length === 0 && tExtra.length === 0 ? 'PASS' : 'FAIL', 'G1 tracking rows == independent leg scan', `${appTracking.size} vs ${refTracking.size}${tMissing.length ? `; missing ${first10(tMissing)}` : ''}${tExtra.length ? `; extra ${first10(tExtra)}` : ''}`)

      // listAuditLogsFor == the old filtered scan. Pairs come from one real page of AuditLog rows (dev holds none for Shipment).
      const sample = (await gql(token, '{ listAuditLogs(limit: 10000) { items { entityType entityId } } }', {})).listAuditLogs.items as { entityType: string; entityId: string }[]
      const pairs = [...new Map(sample.map((e) => [e.entityId, e])).values()].slice(0, 5)
      const pairKey = (e: { entityType: string; entityId: string }) => `${e.entityType}|${e.entityId}`
      const wanted = new Set(pairs.map(pairKey))
      const t = await measure(() => api.listAuditLogsFor(pairs))
      // The old path: a filtered scan of the whole table (raw, so this gate survives the unfiltered export being deleted).
      const oldRows = (await pageAll(token, 'listAuditLogs', {
        decls: '$filter: ModelAuditLogFilterInput', args: 'filter: $filter',
        variables: { filter: { or: pairs.map((e) => ({ entityId: { eq: e.entityId } })) } }, fields: 'id entityType entityId',
      })).rows.filter((e: { entityType: string; entityId: string }) => wanted.has(pairKey(e)))
      const newIds = new Set(t.value.map((e: { id: string }) => e.id))
      const oldIds = new Set(oldRows.map((e: { id: string }) => e.id))
      const aMissing = diff(oldIds, newIds)
      const aExtra = diff(newIds, oldIds)
      out(aMissing.length === 0 && aExtra.length === 0 && oldIds.size > 0 ? 'PASS' : 'FAIL', 'G1 listAuditLogsFor == listAuditLogs([ids])', `${newIds.size} vs ${oldIds.size} entries over ${pairs.length} entities${oldIds.size === 0 ? ' (no rows: vacuous)' : ''}${aMissing.length ? `; missing ${first10(aMissing)}` : ''}${aExtra.length ? `; extra ${first10(aExtra)}` : ''}`)
      // The 2 s budget is for the INDEXED read; before the AuditLog GSI is deployed the client scans (by design), so report only.
      const fields = (await gql(token, '{ __type(name: "Query") { fields { name } } }', {})).__type.fields as { name: string }[]
      if (fields.some((f) => f.name === 'listAuditLogByEntityTypeAndEntityId')) g2('audit:5', t, LOADER_BUDGETS['audit:5'])
      else out('PASS', 'G2 audit:5', `${t.seconds.toFixed(1)} s via fallback scan: AuditLog (entityType, entityId) index not deployed yet, budget applies after the data deploy`)

      // Cached directory equals uncached (a raw read).
      for (const [name, fn, query] of [
        ['customers', () => api.listCustomers({ includeArchived: true }), 'listCustomers'],
        ['carriers', () => api.listCarriers(), 'listCarriers'],
      ] as const) {
        const cached = new Set((await fn()).map((r) => r.id))
        const raw = new Set((await pageAll(token, query, { fields: 'id' })).rows.map((r: { id: string }) => r.id))
        const dMissing = diff(raw, cached)
        const dExtra = diff(cached, raw)
        out(dMissing.length === 0 && dExtra.length === 0 ? 'PASS' : 'FAIL', `G1 cached directory ${name} == uncached`, `${cached.size} vs ${raw.size}`)
      }
    }
  } finally {
    if (made) console.log(`identity deleted: ${await deleteIdentity(email)}`)
  }
  console.log(`\n${failed === 0 ? 'API gates passed' : `${failed} API gate(s) failed`}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => { console.error(`devVerifyPerfApi failed: ${err?.message ?? err}`); process.exit(1) })
