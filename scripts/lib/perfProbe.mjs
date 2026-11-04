/**
 * In-page measurement for devVerifyPerf (PERF-plan.md §11.1).
 *
 *  - HOOK_SOURCE(config)     the document-start script: wraps `fetch` (AppSync / Lambda-URL only) recording start/end/bytes/body,
 *                            and runs a 50 ms in-page ready check so `firstRows` is not quantised by CDP round trips.
 *  - parseOperations(body)   pure: a logged request body -> its top-level GraphQL fields (+ router `action`).
 *  - requestShape(log)       pure: G4/G0 facts from a request log (full-table ops, chain depth, duplicates, mutations).
 *  - measurePage(browser, …) one cold navigation -> { firstRowsS, settledS, requests, mb, ops, rows, ready, problems, … }.
 *
 * "Ready" means the page's REAL rows are in the DOM, never the first element that exists (the earlier probe's 1-2 s false positive).
 */

/** Operations whose names are full-table reads of the six big tables (R1 / G4). */
export const FULL_TABLE_OPS = ['listShipments', 'listOrders', 'listLoads', 'listLoadCarriers', 'listLoadFinancials', 'listAuditLogs']
/** A router mutation whose action reads (the app drives all reads of some tables through `mutation tmsXActions`). */
// Same classification as apiClient.ts READ_ROUTER_ACTION (Step AF5-a): SPOT_COUNT / SPOT_STATUS / SPOT_LIST_REQUESTS / CRM_LIST_* read.
export const READ_ACTION = /^(?:SPOT_|CRM_)?(GET|LIST|SEARCH|FIND|READ|COUNT|PREVIEW|CHECK|LOOKUP|STATUS)(_|$)/
/**
 * Legacy lowercase-action routers that the schema declares as mutations (AppSync custom operations cannot be queries) but whose
 * listed actions only read: managePods list/status (pod-actions: listing and connection status) and manageDispatch status
 * (dispatch-actions: settings read). Exact `field:action` pairs: any other action on these routers is still a G0 mutation.
 */
export const READ_ROUTED = new Set(['managePods:list', 'managePods:status', 'manageDispatch:status'])
export const MAX_CHAIN_DEPTH = 4
export const MAX_REPEATS = 3

// ───────────────────────────── pure parsing ─────────────────────────────
function skipString(text, i) {
  const quote = text[i]
  let j = i + 1
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1
  return j + 1
}

/** Index of the first `{` outside parentheses (the selection set after `query Name($a: T)`). */
function selectionStart(query) {
  let paren = 0
  for (let i = 0; i < query.length; i += 1) {
    const c = query[i]
    if (c === '"') { i = skipString(query, i) - 1; continue }
    if (c === '(') paren += 1
    else if (c === ')') paren -= 1
    else if (c === '{' && paren === 0) return i
  }
  return -1
}

/** Top-level fields of one GraphQL document: [{ name, args }] (aliases resolved to the real field name). */
export function topLevelFields(query) {
  const fields = []
  const start = selectionStart(query)
  if (start < 0) return fields
  let depth = 0
  for (let i = start; i < query.length; i += 1) {
    const c = query[i]
    if (c === '"') { i = skipString(query, i) - 1; continue }
    if (c === '{') { depth += 1; continue }
    if (c === '}') { depth -= 1; if (depth === 0) break; continue }
    if (depth !== 1 || !/[A-Za-z_]/.test(c)) continue
    let j = i
    while (j < query.length && /[A-Za-z0-9_]/.test(query[j])) j += 1
    let name = query.slice(i, j)
    let k = j
    while (/\s/.test(query[k] ?? '')) k += 1
    if (query[k] === ':') { // alias: the real field follows
      k += 1
      while (/\s/.test(query[k] ?? '')) k += 1
      let m = k
      while (m < query.length && /[A-Za-z0-9_]/.test(query[m])) m += 1
      name = query.slice(k, m)
      k = m
      while (/\s/.test(query[k] ?? '')) k += 1
    }
    let args = ''
    if (query[k] === '(') {
      let p = 0
      let m = k
      for (; m < query.length; m += 1) {
        if (query[m] === '"') { m = skipString(query, m) - 1; continue }
        if (query[m] === '(') p += 1
        else if (query[m] === ')') { p -= 1; if (p === 0) break }
      }
      args = query.slice(k + 1, m)
      k = m + 1
    }
    fields.push({ name, args })
    // jump to the end of this field's own selection set so nested names are not read as top-level
    while (/\s/.test(query[k] ?? '')) k += 1
    if (query[k] === '{') {
      let b = 0
      let m = k
      for (; m < query.length; m += 1) {
        if (query[m] === '"') { m = skipString(query, m) - 1; continue }
        if (query[m] === '{') b += 1
        else if (query[m] === '}') { b -= 1; if (b === 0) break }
      }
      i = m
    } else i = k - 1
  }
  return fields
}

const argUsesVariable = (args, variables) => {
  for (const [, ref] of args.matchAll(/\$([A-Za-z0-9_]+)/g)) if (variables?.[ref] != null) return true
  return false
}

/** The page token of a router call: the Lambda-backed `managePods` list carries it inside its AWSJSON `input`, not as a variable. */
function inputToken(variables) {
  if (typeof variables?.input !== 'string') return null
  try { return JSON.parse(variables.input)?.nextToken ?? null } catch { return null }
}

/** One logged body -> [{ type, name, args, nextToken, hasFilter, action, variables }] (one per top-level field per document). */
export function parseOperations(body) {
  let parsed
  try { parsed = JSON.parse(body) } catch { return [] }
  const docs = Array.isArray(parsed) ? parsed : [parsed]
  const out = []
  for (const doc of docs) {
    if (typeof doc?.query !== 'string') {
      if (doc && typeof doc.action === 'string') out.push({ type: 'lambda', name: `action:${doc.action}`, args: '', nextToken: false, hasFilter: false, action: doc.action, variables: {} })
      continue
    }
    const variables = doc.variables ?? {}
    const type = /^\s*mutation\b/.test(doc.query) ? 'mutation' : /^\s*subscription\b/.test(doc.query) ? 'subscription' : 'query'
    for (const field of topLevelFields(doc.query)) {
      out.push({
        type,
        name: field.name,
        args: field.args,
        nextToken: variables.nextToken != null || inputToken(variables) != null || /nextToken:\s*"/.test(field.args),
        hasFilter: /filter:\s*\{/.test(field.args) || (/filter:\s*\$/.test(field.args) && argUsesVariable(field.args.match(/filter:\s*\$[A-Za-z0-9_]+/)?.[0] ?? '', variables)),
        action: typeof variables.action === 'string' ? variables.action : null,
        variables,
      })
    }
  }
  return out
}

/** Chain identity: same field and same variables apart from the page token. */
const chainKey = (op) => {
  const rest = { ...(op.variables ?? {}) }
  delete rest.nextToken
  if (typeof rest.input === 'string') {
    try { const { nextToken: _drop, ...input } = JSON.parse(rest.input); rest.input = input } catch { /* not JSON: keep as is */ }
  }
  return `${op.name}|${op.args.replace(/nextToken:\s*"[^"]*"/, '')}|${JSON.stringify(rest)}`
}

/**
 * G0 + G4 facts from a request log (entries as `{ body }`).
 * fullTable:  full-table ops seen (listAuditLogs only when it carries no filter).
 * requestsByOp: HTTP requests that carried each operation (an aliased batch is one request, however many aliases).
 * bytesByOp:  response bytes by operation (a multi-operation request is split evenly).
 * maxDepth:   longest nextToken chain of any single operation.
 * repeated:   operations whose chain STARTED more than MAX_REPEATS times (the duplicate-mount regression).
 * mutations:  non-read mutations (G0).
 */
export function requestShape(log) {
  const ops = log.flatMap((e) => parseOperations(e.body ?? ''))
  const requestsByOp = {}
  const bytesByOp = {}
  for (const e of log) {
    const names = [...new Set(parseOperations(e.body ?? '').map((op) => op.name))]
    if (names.length === 0) names.push(`(unparsed ${e.url ?? 'request'})`)
    for (const name of names) {
      requestsByOp[name] = (requestsByOp[name] ?? 0) + 1
      bytesByOp[name] = (bytesByOp[name] ?? 0) + (e.bytes ?? 0) / names.length // an aliased batch splits its response evenly
    }
  }
  const counts = {}
  const chains = new Map()
  const starts = new Map()
  for (const op of ops) {
    counts[op.name] = (counts[op.name] ?? 0) + 1
    const key = chainKey(op)
    chains.set(key, (chains.get(key) ?? 0) + 1)
    if (!op.nextToken) starts.set(key, (starts.get(key) ?? 0) + 1)
  }
  const fullTable = [...new Set(ops
    .filter((op) => op.type === 'query' && FULL_TABLE_OPS.includes(op.name) && (op.name !== 'listAuditLogs' || !op.hasFilter))
    .map((op) => op.name))]
  const depthOf = new Map()
  for (const [key, n] of chains) {
    const name = key.split('|')[0]
    depthOf.set(name, Math.max(depthOf.get(name) ?? 0, n))
  }
  const repeated = [...starts].filter(([, n]) => n > MAX_REPEATS).map(([key, n]) => ({ op: key.split('|')[0], times: n }))
  const mutations = [...new Set(ops
    .filter((op) => op.type === 'mutation' && !(op.action && (READ_ACTION.test(op.action) || READ_ROUTED.has(`${op.name}:${op.action}`))))
    .map((op) => (op.action ? `${op.name}:${op.action}` : op.name)))]
  return { counts, requestsByOp, bytesByOp, fullTable, maxDepth: Math.max(0, ...depthOf.values()), depthByOp: Object.fromEntries(depthOf), repeated, mutations }
}

// ───────────────────────────── KPI detection (Step AF, AF-plan §6.1) ─────────────────────────────
/** The DOM contract: data-testid on the KPI wrapper of each page (AF3 produces dash-kpis, AF4 legacy-kpis). */
export const KPI_TESTIDS = { '/tms/dashboard': 'dash-kpis', '/dashboard': 'legacy-kpis' }

/**
 * Is the KPI strip honestly visible? Pure and self-contained: HOOK_SOURCE embeds this function's source, so what the unit
 * tests pin is what runs in the page.
 *   f = { state: data-state attribute, text: strip text, skeleton: a skeleton / aria-busy descendant exists }
 * dash-kpis:    state "ready", no skeleton, four money values (Revenue, Profit, Open AR, Open AP) and an "N shipments" sub-line.
 * legacy-kpis:  state "ready", no skeleton, a loads count > 0 ("171 loads" or "Loads 171").
 * A skeleton, a placeholder zero or a not-yet-ready strip never counts.
 */
export function kpiReadiness(testId, f) {
  if (!f || f.state !== 'ready' || f.skeleton) return false
  const t = f.text || ''
  if (testId === 'dash-kpis') return (t.match(/\$[\d,]+/g) || []).length >= 4 && /\d+ shipments?/.test(t)
  if (testId === 'legacy-kpis') {
    const m = t.match(/(\d[\d,]*)\s+loads?\b/i) || t.match(/\bloads?\b\D{0,24}?(\d[\d,]*)/i)
    return !!m && Number(m[1].replace(/,/g, '')) > 0
  }
  return false
}

// ───────────────────────────── in-page hook ─────────────────────────────
/**
 * config: { minRows, expectEmpty, minCharts, kpi: bool, kpiTestId?: 'dash-kpis'|'legacy-kpis', rowSelector?: string, readyOps?: regex source }
 *  - kpiTestId: Step AF KPI stamps on window.__perf (all ms on the performance clock; t0 = 0 on a navigation, set by __perfMark() for in-app runs):
 *      kpiAt (first kpiReadiness), kpiSource/kpiAsOf (data-source/data-asof then), kpiRequests (AppSync requests STARTED before it),
 *      kpiMb (MB COMPLETED before it), kpiFlips (changes of the strip's digits after kpiAt), chartAt (first .recharts-surface),
 *      lastChangeAt (last change of the first 1,400 characters of the page text).
 *  - readyOps: legacy pages have no row markers; ready = a request matching it completed AND the network has been quiet 1.5 s (firstRows is stamped at that last response).
 *  - rows:    rows in the DOM (tbody tr minus colspan empty-states, [role=row] minus header rows, [data-testid*=row] words, or rowSelector).
 *  - ready:   expectEmpty ? empty state visible : rows >= minRows (and charts >= minCharts, and the first KPI sub-line has loaded when kpi).
 */
export function HOOK_SOURCE(config) {
  return `(() => {
  if (window.__perf) return
  const cfg = ${JSON.stringify(config)}
  const T = () => performance.now()
  const st = { reqs: [], inflight: 0, lastEnd: 0, lastStart: 0, bytes: 0, firstRowsAt: null, rows: 0, charts: 0 }
  window.__perf = st
  const track = (url) => /appsync-api\\.|lambda-url\\./.test(url)
  const orig = window.fetch.bind(window)
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    if (!track(url)) return orig(input, init)
    const entry = { url: url.replace(/^https:\\/\\//, '').split('/')[0], body: typeof (init && init.body) === 'string' ? init.body.slice(0, 1000000) : '', start: T(), end: null, bytes: 0, status: 0 }
    st.reqs.push(entry); st.inflight += 1; st.lastStart = entry.start
    const done = () => { entry.end = T(); st.lastEnd = entry.end; st.inflight -= 1 }
    return orig(input, init).then((res) => {
      entry.status = res.status
      res.clone().arrayBuffer().then((buf) => { entry.bytes = buf.byteLength; st.bytes += buf.byteLength; done() }, done)
      return res
    }, (err) => { entry.status = -1; done(); throw err })
  }
  const kpiReadiness = ${kpiReadiness.toString()}
  st.t0 = 0; st.reqBase = 0; st.bytesBase = 0; st.kpiAt = null; st.chartAt = null; st.lastChangeAt = null; st.kpiFlips = 0
  let kpiSig = null; let pageSig = null
  window.__perfMark = () => { st.t0 = T(); st.reqBase = st.reqs.length; st.bytesBase = st.bytes; st.kpiAt = null; st.chartAt = null; st.lastChangeAt = null; st.kpiFlips = 0; kpiSig = null; pageSig = null }
  const kpiProbe = () => {
    if (!cfg.kpiTestId || !document.body) return
    const now = T()
    const el = document.querySelector('[data-testid="' + cfg.kpiTestId + '"]')
    if (el && st.kpiAt == null) {
      const f = { state: el.getAttribute('data-state'), text: el.innerText || '', skeleton: !!el.querySelector('[aria-busy="true"], [data-skeleton], .tms-skeleton') }
      if (kpiReadiness(cfg.kpiTestId, f)) {
        st.kpiAt = now; st.kpiSource = el.getAttribute('data-source'); st.kpiAsOf = el.getAttribute('data-asof')
        st.kpiRequests = st.reqs.length - st.reqBase; st.kpiMb = (st.bytes - st.bytesBase) / 1e6
        kpiSig = f.text.replace(/\\D/g, '')
      }
    } else if (el && st.kpiAt != null) {
      const sig = (el.innerText || '').replace(/\\D/g, '')
      if (sig !== kpiSig) { st.kpiFlips += 1; kpiSig = sig }
      st.kpiFlipsAttr = el.getAttribute('data-kpi-flips')
    }
    if (st.chartAt == null && document.querySelector('.recharts-surface')) st.chartAt = now
    const sig = ((document.querySelector('.tms-main') || document.body).innerText || '').slice(0, 1400).replace(/\\D/g, '')
    if (sig !== pageSig) { pageSig = sig; st.lastChangeAt = now }
  }
  setInterval(kpiProbe, 25)
  const word = /(^|[-_])row/i
  const count = () => {
    let rows
    if (cfg.rowSelector) rows = document.querySelectorAll(cfg.rowSelector).length
    else {
      const trs = [...document.querySelectorAll('tbody tr')].filter((tr) => !(tr.children.length === 1 && tr.children[0].hasAttribute('colspan'))).length
      const roles = [...document.querySelectorAll('[role=row]')].filter((r) => !r.querySelector('[role=columnheader]') && !r.closest('thead')).length
      const ids = [...document.querySelectorAll('[data-testid*="row"]')].filter((e) => word.test(e.getAttribute('data-testid') || '')).length
      rows = Math.max(trs, roles, ids)
    }
    st.rows = rows
    st.charts = document.querySelectorAll('.recharts-surface').length
    const sub = document.querySelector('.tms-dash-kpis .tms-kpi-card-sub')
    st.kpiSub = sub ? sub.textContent.trim() : null
    const main = document.querySelector('.tms-main') || document.body
    if (!main) return // the hook is injected before <body> exists on a cold navigation
    st.empty = !!main.querySelector('[data-testid*="empty"], .tms-empty, [class*="empty-state"]') || /\\bno (loads|shipments|results|rows|customers|carriers|invoices|bills|items|data|matching)\\b/i.test(main.innerText || '')
    let ok = cfg.expectEmpty ? st.empty && rows === 0 : rows >= cfg.minRows
    if (cfg.minCharts) ok = ok && st.charts >= cfg.minCharts
    if (cfg.kpi) ok = ok && (st.kpiAt != null || /^\\d+ shipments?$/.test(st.kpiSub || ''))
    if (cfg.readyOps) {
      const re = new RegExp(cfg.readyOps)
      const quiet = st.inflight === 0 && T() - Math.max(st.lastEnd, st.lastStart) >= 1500
      const viaOps = quiet && st.reqs.some((r) => r.end != null && re.test(r.body))
      // Step AF: a page that paints its KPIs from the rollup issues no load reads; the KPI contract is ready on its own.
      const viaKpi = !!cfg.kpiTestId && st.kpiAt != null
      ok = ok && (viaOps || viaKpi)
      if (ok && st.firstRowsAt == null) { st.firstRowsAt = viaKpi && !viaOps ? T() : st.lastEnd; return }
    }
    if (ok && st.firstRowsAt == null) st.firstRowsAt = T()
  }
  setInterval(count, 50)
})()`
}

// ───────────────────────────── one cold measurement ─────────────────────────────
const SNAPSHOT = `(() => { const s = window.__perf; if (!s) return null; return { href: location.href, now: performance.now(), inflight: s.inflight, lastEnd: s.lastEnd, lastStart: s.lastStart, bytes: s.bytes, requests: s.reqs.length, firstRowsAt: s.firstRowsAt, rows: s.rows, charts: s.charts, kpiSub: s.kpiSub ?? null, empty: !!s.empty } })()`
const FULL_LOG = `(() => window.__perf ? window.__perf.reqs.map((r) => ({ url: r.url, body: r.body, start: r.start, end: r.end, bytes: r.bytes, status: r.status })) : [])()`

/**
 * One cold navigation of `path`.
 *   spec: { minRows, expectEmpty, minCharts, kpi, rowSelector } (see HOOK_SOURCE)
 * Cold = a fresh `Page.navigate` after about:blank (module caches die with the document).
 * settled = ready (or, if never ready, 10 s of quiet), nothing in flight and no request for `quietMs`, at least `minSettleMs` after navigation.
 */
export async function measurePage(browser, path, spec, { quietMs = 2000, minSettleMs = 3000, hardMs = 75_000, pollMs = 150 } = {}) {
  const { identifier } = await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE(spec) })
  try {
    await browser.navigate('about:blank')
    await browser.pause(300)
    browser.mark()
    await browser.navigate(path)
    const t0 = Date.now()
    let last = null
    for (;;) {
      await browser.pause(pollMs)
      const snap = await browser.evaluate(SNAPSHOT).catch(() => null)
      if (snap && !snap.href.startsWith('about:')) {
        last = snap
        const lastActivity = Math.max(snap.lastEnd, snap.lastStart)
        const quiet = snap.inflight === 0 && snap.now - lastActivity >= quietMs && snap.now >= minSettleMs
        const readyDone = snap.firstRowsAt != null
        if (quiet && readyDone) break
        if (quiet && !readyDone && snap.now >= 10_000 + minSettleMs && snap.now - lastActivity >= 10_000) break
      }
      if (Date.now() - t0 > hardMs) break
    }
    const log = (await browser.evaluate(FULL_LOG).catch(() => [])) ?? []
    const problems = browser.problems()
    const ready = last?.firstRowsAt != null
    const firstRowsS = ready ? last.firstRowsAt / 1000 : null
    const settledS = last ? Math.max(last.lastEnd, last.firstRowsAt ?? 0) / 1000 : null
    return {
      path,
      firstRowsS,
      settledS,
      requests: log.length,
      mb: (last?.bytes ?? 0) / 1e6,
      rows: last?.rows ?? 0,
      charts: last?.charts ?? 0,
      kpiSub: last?.kpiSub ?? null,
      emptyState: last?.empty ?? false,
      inflightAtEnd: last?.inflight ?? null,
      timedOut: Date.now() - t0 > hardMs,
      shape: requestShape(log),
      problems,
    }
  } finally {
    await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {})
  }
}

// ───────────────────────────── Step AF: modes (cold / warm / spa) ─────────────────────────────
const KPI_SNAPSHOT = `(() => { const s = window.__perf; if (!s) return null; return { href: location.href, now: performance.now(), inflight: s.inflight, lastEnd: s.lastEnd, lastStart: s.lastStart, t0: s.t0, reqBase: s.reqBase, bytes: s.bytes, bytesBase: s.bytesBase, requests: s.reqs.length, kpiAt: s.kpiAt, kpiSource: s.kpiSource ?? null, kpiAsOf: s.kpiAsOf ?? null, kpiRequests: s.kpiRequests ?? null, kpiMb: s.kpiMb ?? null, kpiFlips: s.kpiFlips, kpiFlipsAttr: s.kpiFlipsAttr ?? null, chartAt: s.chartAt, lastChangeAt: s.lastChangeAt } })()`

const secs = (at, t0) => (at == null ? null : Math.max(0, at - t0) / 1000)

/** Wait until the KPI strip was seen and the network has been quiet `quietMs` (flips and charts are collected meanwhile). */
async function awaitKpiRun(browser, { quietMs = 2000, hardMs = 60_000, pollMs = 100 }) {
  const t0 = Date.now()
  let last = null
  for (;;) {
    await browser.pause(pollMs)
    const snap = await browser.evaluate(KPI_SNAPSHOT).catch(() => null)
    if (snap && !snap.href.startsWith('about:')) {
      last = snap
      const quiet = snap.inflight === 0 && snap.now - Math.max(snap.lastEnd, snap.lastStart) >= quietMs
      if (quiet && snap.kpiAt != null) break
      if (quiet && snap.kpiAt == null && snap.now - snap.t0 >= 12_000 + quietMs) break // never visible: report null, do not hang
    }
    if (Date.now() - t0 > hardMs) break
  }
  const log = (await browser.evaluate(FULL_LOG).catch(() => [])) ?? []
  const base = last?.reqBase ?? 0
  const runLog = log.slice(base)
  return {
    kpiS: secs(last?.kpiAt, last?.t0 ?? 0),
    chartS: secs(last?.chartAt, last?.t0 ?? 0),
    lastChangeS: secs(last?.lastChangeAt, last?.t0 ?? 0),
    kpiSource: last?.kpiSource ?? null,
    kpiAsOf: last?.kpiAsOf ?? null,
    kpiRequests: last?.kpiRequests ?? null,
    kpiMb: last?.kpiMb ?? null,
    kpiFlips: last?.kpiFlips ?? null,
    kpiFlipsAttr: last?.kpiFlipsAttr ?? null,
    requests: runLog.length,
    mb: ((last?.bytes ?? 0) - (last?.bytesBase ?? 0)) / 1e6,
    timedOut: Date.now() - t0 > hardMs,
    shape: requestShape(runLog),
    problems: browser.problems(),
  }
}

async function navigateKpi(browser, path) {
  await browser.navigate('about:blank')
  await browser.pause(300)
  browser.mark()
  await browser.navigate(path)
}

/**
 * Step AF modes for one dashboard page (promoted from the baseline probe, AF-plan §6.2). Viewport is the launcher's job (1440x900).
 *   launch: async () => browser   a fresh Chrome profile (cdpBrowser.launchBrowser with the temp admin's storage)
 *   spec:   { kpiTestId, spaFrom?: '/tms/carriers' }   the hook is installed with { kpiTestId, minRows: 0 }
 *   runs:   { cold, warm, spa }   (default 3 each; 0 skips a mode)
 * cold = a brand-new profile per run (bundle uncached). warm = same browser, one unmeasured priming load, then about:blank ->
 * navigate (HTTP cache warm, module caches empty). spa = load spaFrom, wait for quiet, click a[href=path]; the clock starts at the click.
 * Returns { cold: [run], warm: [run], spa: [run] } with run as in awaitKpiRun.
 */
export async function measureModes(launch, path, spec, runs = { cold: 3, warm: 3, spa: 3 }) {
  const hook = HOOK_SOURCE({ minRows: 0, kpiTestId: spec.kpiTestId })
  const withHook = async (browser) => { await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: hook }); return browser }
  const out = { cold: [], warm: [], spa: [] }
  for (let i = 0; i < (runs.cold ?? 0); i += 1) {
    const b = await withHook(await launch())
    try { await navigateKpi(b, path); out.cold.push({ mode: 'cold', ...(await awaitKpiRun(b, {})) }) } finally { await b.close().catch(() => {}) }
  }
  if (runs.warm) {
    const b = await withHook(await launch())
    try {
      await navigateKpi(b, path); await awaitKpiRun(b, {}) // prime the HTTP cache (unmeasured)
      for (let i = 0; i < runs.warm; i += 1) { await navigateKpi(b, path); out.warm.push({ mode: 'warm', ...(await awaitKpiRun(b, {})) }) }
    } finally { await b.close().catch(() => {}) }
  }
  if (runs.spa) {
    const b = await withHook(await launch())
    try {
      for (let i = 0; i < runs.spa; i += 1) {
        await navigateKpi(b, spec.spaFrom ?? '/tms/carriers')
        await awaitKpiRun(b, {}) // shell warm and quiet
        b.mark()
        await b.evaluate('window.__perfMark()')
        await b.click(`a[href="${path}"]`)
        out.spa.push({ mode: 'spa', ...(await awaitKpiRun(b, {})) })
      }
    } finally { await b.close().catch(() => {}) }
  }
  return out
}

// ───────────────────────────── Step AF: G12 cache hygiene ─────────────────────────────
/**
 * Per-operation repeat budget over a soak: counts the HTTP requests that STARTED a chain of each operation (requestShape.repeated only
 * reports > MAX_REPEATS, which cannot see a working-set read that is issued twice because a router poll wiped the cache).
 * budget: { op: maxStarts }. Returns the offenders [{ op, times, max }].
 */
export function repeatViolations(log, budget) {
  const starts = {}
  for (const e of log) { // one HTTP request = one start, however many aliases it batches (the 15-status read is ONE request)
    for (const name of new Set(parseOperations(e.body ?? '').filter((op) => !op.nextToken).map((op) => op.name))) starts[name] = (starts[name] ?? 0) + 1
  }
  return Object.entries(budget).filter(([name, max]) => (starts[name] ?? 0) > max).map(([name, max]) => ({ op: name, times: starts[name], max }))
}

/** Soak one page for `ms` after it is ready and return the request log (browser must already have the hook: see measureSoak). */
export async function measureSoak(browser, path, spec, ms = 14_000) {
  const { identifier } = await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE({ minRows: 0, ...spec }) })
  try {
    await navigateKpi(browser, path)
    await browser.pause(ms)
    return (await browser.evaluate(FULL_LOG).catch(() => [])) ?? []
  } finally {
    await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {})
  }
}
