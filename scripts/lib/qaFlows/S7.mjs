import { AA_HOMES } from '../aaRoutes.mjs'
import { record, expect, short, settle } from '../qaFlowsKit.mjs'

export const TITLE = 'auth class: every nav page, ACCESS token, no Unauthorized / could not resolve caller / Forbidden'

const BAD = /unauthorized|could not resolve caller|forbidden|not authorized/i

export async function run(ctx) {
  const routes = AA_HOMES
    .filter((r) => ['page', 'hidden', 'offnav'].includes(r.kind) && !r.pattern.includes(':') && !r.pattern.includes('*'))
    .map((r) => r.pattern)
  const b = await ctx.newBrowser('admin')
  try {
    // Warm: the first navigation signs in from the injected storage.
    await b.navigate('/tms/dashboard')
    await settle(b)
    let tokenUse = {}
    const idCalls = []
    const errorSamples = new Map()
    let bad = 0
    for (const path of routes) {
      try {
        await b.navigate(path)
        await b.evaluate('window.__qa ? 0 : 0')
        const text = await settle(b, { min: 40, quietMs: 1800, timeout: 40_000 })
        const url = await b.evaluate('location.pathname')
        const qa = await b.evaluate('JSON.stringify(window.__qa || {})').then(JSON.parse).catch(() => ({}))
        for (const [k, v] of Object.entries(qa.tokenUse ?? {})) tokenUse[k] = (tokenUse[k] ?? 0) + v
        for (const c of qa.idCalls ?? []) idCalls.push(`${path} -> ${c}`)
        for (const e of qa.errors ?? []) { const k = JSON.stringify(e.found).slice(0, 140); errorSamples.set(k, (errorSamples.get(k) ?? 0) + 1) }
        const hit = text.match(BAD)
        const errs = (qa.errors ?? []).filter((e) => BAD.test(JSON.stringify(e.found)))
        const unauth = errs.length
        expect(!hit, `page text contains "${hit?.[0]}" (landed ${url})`)
        expect(unauth === 0, `${unauth} router/AppSync response(s) carried an auth error: ${JSON.stringify(errs[0]?.found)}`)
        record('PASS', 'S7.page', path, `landed ${url}; text ${text.length} chars; ${qa.calls ?? 0} api calls; ${(qa.errors ?? []).length} responses with an errors array`)
      } catch (err) {
        bad++
        record('FAIL', 'S7.page', path, short(err))
        await b.capture(`s7-fail-${path.replace(/\W+/g, '_')}.png`).catch(() => {})
      }
    }
    record(tokenUse.access && !tokenUse.id ? 'PASS' : 'PARTIAL', 'S7.token', 'browser sends the ACCESS token to AppSync/routers', `${JSON.stringify(tokenUse)}${idCalls.length ? ` ID-token calls: ${idCalls.slice(0, 5).join(' | ')}` : ''}`)
    record('PASS', 'S7.errors', 'non-auth GraphQL error responses seen across the walk (message -> count)', JSON.stringify([...errorSamples].slice(0, 12)))
    record(bad === 0 ? 'PASS' : 'FAIL', 'S7.total', `${routes.length} routes walked as admin`, `${bad} with an auth gap`)
  } finally { await b.close() }

  // The same router calls from node with the ACCESS token (API half).
  const a = ctx.id.admin
  const spotRouter = (await import('../devIdentity.mjs')).routerAs(a.access, 'tmsSpotActions')
  const crm = (await import('../devIdentity.mjs')).routerAs(a.access, 'tmsCrmActions')
  const trk = (await import('../devIdentity.mjs')).routerAs(a.access, 'tmsTrackingActions')
  const probes = [
    ['tmsShipmentActions GET_SHIPMENT_BUNDLE', () => a.ship('GET_SHIPMENT_BUNDLE', { shipmentId: 'zz-none' })],
    ['tmsDirectoryActions LIST_IMPORT_JOBS', () => a.dir('LIST_IMPORT_JOBS', {})],
    ['tmsCarrierActions UPSERT_CARRIER (validation only)', () => a.car('UPSERT_CARRIER', {})],
    ['tmsFinanceActions PREVIEW_INVOICE (validation only)', () => a.fin('PREVIEW_INVOICE', {})],
    ['tmsSpotActions SPOT_LIST_REQUESTS', () => spotRouter('SPOT_LIST_REQUESTS', {})],
    ['tmsCrmActions CRM_LIST_ACCOUNTS', () => crm('CRM_LIST_ACCOUNTS', {})],
    ['tmsTrackingActions LIST_SHIPMENT_THREAD (validation only)', () => trk('LIST_SHIPMENT_THREAD', {})],
  ]
  for (const [name, call] of probes) {
    let msg = ''
    await call().then(() => {}, (e) => { msg = short(e) })
    record(!BAD.test(msg) ? 'PASS' : 'FAIL', 'S7.api', `${name} with the ACCESS token`, msg ? `non-auth answer: ${msg.slice(0, 120)}` : 'ok')
  }
}
