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
export const READ_ACTION = /^(GET|LIST|SEARCH|FIND|READ|COUNT|PREVIEW|CHECK|LOOKUP)_/
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

// ───────────────────────────── in-page hook ─────────────────────────────
/**
 * config: { minRows, expectEmpty, minCharts, kpi: bool, rowSelector?: string, readyOps?: regex source }
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
    if (cfg.kpi) ok = ok && /^\\d+ shipments?$/.test(st.kpiSub || '')
    if (cfg.readyOps) {
      const re = new RegExp(cfg.readyOps)
      const quiet = st.inflight === 0 && T() - Math.max(st.lastEnd, st.lastStart) >= 1500
      ok = ok && quiet && st.reqs.some((r) => r.end != null && re.test(r.body))
      if (ok && st.firstRowsAt == null) { st.firstRowsAt = st.lastEnd; return }
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
