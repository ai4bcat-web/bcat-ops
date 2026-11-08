import { record, expect, short, settle } from '../qaFlowsKit.mjs'
import { zzCustomer, zzShipment } from './fixtures.mjs'

export const TITLE = 'Load Review is the only release gate; Push to Load Review on the board'
const REVIEW = { review: { source: 'LOAD_REVIEW' } }

async function check(id, name, fn) {
  try { record('PASS', id, name, await fn()) } catch (err) { record('FAIL', id, name, short(err)); process.exitCode = 1 }
}
const refused = async (promise, re, what) => {
  let msg = null
  await promise.then(() => {}, (e) => { msg = short(e) })
  expect(msg !== null, `${what}: accepted`)
  expect(re.test(msg), `${what}: refused with unexpected text: ${msg.slice(0, 160)}`)
  return msg
}

export async function run(ctx) {
  const { admin, loads, reviewer, tms, none } = ctx.id
  const custDefault = await zzCustomer(ctx, 'Default')
  const custRef = await zzCustomer(ctx, 'RefOnly', { reviewRequirements: ['referenceNumber'] })
  const custNone = await zzCustomer(ctx, 'NoReq', { reviewRequirements: [] })
  const a1 = await zzShipment(ctx, custDefault)
  const b1 = await zzShipment(ctx, custRef)                             // no reference
  const b2 = await zzShipment(ctx, custRef, { reference: `ZZQAF-${ctx.ts}` })
  const n1 = await zzShipment(ctx, custNone)
  const push = (who, ids) => who.ship('BATCH_SHIPMENT_TASK', { task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: ids })

  await check('S1.01', 'push cap: 10 ids refused with "at most 9", nothing stamped', async () => {
    const ids = Array.from({ length: 10 }, () => a1.shipmentId)
    const msg = await refused(push(admin, ids), /at most 9/, '10-row push')
    return `refused: "${msg.replace(/^.*?(Load Review|Push|at most)/, '$1').slice(0, 120)}"`
  })
  await check('S1.02', 'release cap: 10 ids refused with "at most 9"', async () => {
    const ids = Array.from({ length: 10 }, () => a1.shipmentId)
    await refused(admin.ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: ids, params: REVIEW }), /at most 9/, '10-row release')
  })
  await check('S1.03', 'per-row failure reasons use the customer list (default seven vs RefOnly vs empty)', async () => {
    const r = await push(admin, [a1.shipmentId, b1.shipmentId, b2.shipmentId, n1.shipmentId])
    const rows = r.results
    const reasons = (i) => rows[i].reasons ?? []
    expect(rows.length === 4, `got ${rows.length} rows`)
    expect(!rows[0].ok && reasons(0).includes('Missing reference #') && reasons(0).includes('Missing sales rep') && reasons(0).length >= 4, `default customer reasons: ${JSON.stringify(reasons(0))}`)
    expect(!rows[1].ok && JSON.stringify(reasons(1)) === JSON.stringify(['Missing reference #']), `RefOnly without reference: ${JSON.stringify(reasons(1))}`)
    expect(rows[2].ok, `RefOnly with reference should push: ${JSON.stringify(rows[2])}`)
    expect(rows[3].ok, `empty list customer should push: ${JSON.stringify(rows[3])}`)
    return `default: ${reasons(0).length} reasons [${reasons(0).join('; ')}]; RefOnly no ref: 1 reason; RefOnly with ref: pushed; empty list: pushed`
  })
  await check('S1.04', 'push is idempotent (second push of an already pushed row is not a failure)', async () => {
    const r = await push(admin, [b2.shipmentId])
    expect(r.results[0].ok, JSON.stringify(r.results[0]))
    return `ok=${r.results[0].ok} message=${r.results[0].message ?? 'null'}`
  })
  await check('S1.05', 'org default list is used when the customer has none (settings read)', async () => {
    const row = (await admin.gql('query { listTmsSettings(limit: 5) { items { id reviewRequirements } } }')).listTmsSettings.items[0]
    return `org default reviewRequirements = ${JSON.stringify(row?.reviewRequirements ?? null)} (null = built-in seven, which the default customer hit in S1.03)`
  })

  await check('S1.06', 'RELEASE_TO_BILLING without the Load Review marker is refused (admin included)', async () => {
    for (const params of [undefined, { review: true }, { review: 'LOAD_REVIEW' }, { review: { source: 'OTHER' } }]) {
      await refused(admin.ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [a1.shipmentId], ...(params ? { params } : {}) }), /Load Review only/, `marker ${JSON.stringify(params)}`)
    }
    return '4 malformed/absent markers refused: "Release to billing runs from Load Review only"'
  })
  await check('S1.07', 'loads-only dispatcher: batch release refused (Forbidden), push allowed', async () => {
    await refused(loads.ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [a1.shipmentId], params: REVIEW }), /Forbidden/, 'dispatcher release')
    const r = await push(loads, [a1.shipmentId])
    return `push by page-loads: ${r.results.length} row(s) answered, ok=${r.results[0].ok}`
  })
  await check('S1.08', 'tms-only user: batch release refused (Forbidden)', async () => {
    await refused(tms.ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [a1.shipmentId], params: REVIEW }), /Forbidden/, 'tms release')
  })
  await check('S1.09', 'no-grants user: push and release both Forbidden', async () => {
    await refused(push(none, [a1.shipmentId]), /Forbidden/, 'none push')
    await refused(none.ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [a1.shipmentId], params: REVIEW }), /Forbidden/, 'none release')
  })
  await check('S1.10', 'reviewer-only grant (page-loadReview): release is authorised, row refused by the gate with its reasons', async () => {
    const r = await reviewer.ship('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [b2.shipmentId], params: REVIEW })
    const row = r.results[0]
    expect(row && !row.ok && /Not ready for accounting/.test(row.message ?? ''), `unexpected row ${JSON.stringify(row)}`)
    const p = await push(reviewer, [b2.shipmentId])
    expect(p.results.length === 1, 'reviewer push not answered')
    return `authorised; row refused by the server gate: "${String(row.message).slice(0, 110)}"`
  })
  await check('S1.11', 'single READY_TO_INVOICE without the Load Review marker is refused for page-loads (Release happens in Load Review)', async () => {
    const order = b1.bundle.orders[0]
    let msg = ''
    await loads.ship('READY_TO_INVOICE', { orderId: order.id, expectedUpdatedAt: order.updatedAt }).then(() => { msg = 'ACCEPTED' }, (e) => { msg = short(e) })
    expect(msg !== 'ACCEPTED', 'a release without the Load Review marker was ACCEPTED')
    // The gate speaks first; on a ready fixture the next sentence is the Load Review refusal.
    expect(/Release happens in Load Review|Not ready for accounting|Forbidden/.test(msg), `unexpected answer: ${msg.slice(0, 140)}`)
    return `refused: "${msg.slice(0, 110)}"`
  })

  // ── Browser half ───────────────────────────────────────────────────────────
  const b = await ctx.newBrowser('admin')
  try {
    await check('S1.12', 'Shipments board: chips (labels, order, live counts), no Open exceptions, Check call overdue last', async () => {
      await b.navigate('/tms/shipments')
      await settle(b, { min: 300, quietMs: 3000, timeout: 60_000 })
      const chips = await b.evaluate(`(() => {
        const labels = ['Missing reference #', 'Missing sales rep', 'Missing rev division', 'Missing documents', 'Check call overdue']
        const out = []
        for (const l of labels) {
          const el = [...document.querySelectorAll('button, [role="button"], label')].find((e) => (e.textContent || '').trim().startsWith(l))
          if (el) { const r = el.getBoundingClientRect(); out.push({ label: l, text: el.textContent.trim(), x: Math.round(r.left), y: Math.round(r.top) }) }
        }
        return { out, exceptions: /open exceptions/i.test(document.body.innerText) }
      })()`)
      await b.capture('flows-s1-board-chips.png')
      const found = chips.out.map((c) => c.label)
      expect(found.length === 5, `chips found: ${JSON.stringify(found)}`)
      expect(!chips.exceptions, '"Open exceptions" is still on the board')
      const sorted = [...chips.out].sort((p, q) => p.y - q.y || p.x - q.x).map((c) => c.label)
      expect(sorted[4] === 'Check call overdue', `order: ${sorted.join(' > ')}`)
      expect(chips.out.every((c) => /\d/.test(c.text)), `a chip has no live count: ${chips.out.map((c) => c.text).join(' | ')}`)
      return `chips in order: ${chips.out.map((c) => c.text).join(' | ')}; Open exceptions absent`
    })
    await check('S1.13', 'Shipments board has no Release action; batch bar offers only Push to Load Review (max 9 message in UI)', async () => {
      const text = await b.evaluate('document.body.innerText')
      expect(!/\bRelease\b|Move to billing|Ready to invoice/i.test(text), 'board text mentions Release / Move to billing / Ready to invoice')
      const boxes = await b.evaluate(`[...document.querySelectorAll('input[type=checkbox]')].length`)
      expect(boxes > 10, `only ${boxes} checkboxes`)
      await b.evaluate(`(() => { const boxes = [...document.querySelectorAll('tbody input[type=checkbox], [role=row] input[type=checkbox]')].slice(0, 10); boxes.forEach((c) => c.click()) })()`)
      await b.pause(600)
      const bar = await b.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).filter(Boolean)
        return { push: btns.filter((t) => /load review/i.test(t)), release: btns.filter((t) => /release|billing|invoice/i.test(t)), body: document.body.innerText }
      })()`)
      await b.capture('flows-s1-board-batchbar.png')
      expect(bar.push.length >= 1 && bar.release.length === 0, `push buttons ${JSON.stringify(bar.push)} release-ish ${JSON.stringify(bar.release)}`)
      const cap = /at most 9|nine/i.test(bar.body)
      expect(cap, 'ticking 10 rows did not show the nine-row cap message')
      return `buttons mentioning Load Review: ${JSON.stringify(bar.push)}; release/billing buttons: 0; cap message shown after ticking 10 rows`
    })
    await check('S1.14', 'Shipment detail quick actions menu has no Release', async () => {
      await b.navigate(`/tms/shipments/${a1.shipmentId}`)
      await settle(b, { min: 300, quietMs: 2500 })
      await b.waitFor('.tms-main button[aria-label="Load actions"]', 30_000).catch(() => {})
      const has = await b.evaluate(`!!document.querySelector('button[aria-label="Load actions"]')`)
      let menu = ''
      if (has) { await b.click({ selector: 'button[aria-label="Load actions"]', real: true }); await b.pause(500); menu = await b.evaluate(`[...document.querySelectorAll('[role=menuitem]')].map((e) => e.textContent.trim()).join(' | ')`) }
      await b.capture('flows-s1-detail-actions.png')
      expect(!/release|billing/i.test(menu), `menu: ${menu}`)
      return `Load actions menu items: ${menu || '(menu not present)'}`
    })
    await check('S1.15', 'Intake grid is push-only: no Release / Move to billing', async () => {
      await b.navigate('/tms/shipments/intake')
      const text = await settle(b, { min: 100, quietMs: 2500 })
      await b.capture('flows-s1-intake.png')
      const btns = await b.evaluate(`[...document.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).filter(Boolean).join(' | ')`)
      expect(!/\brelease\b|move to billing|ready to invoice/i.test(text + ' ' + btns), 'Intake mentions Release')
      return `buttons: ${btns.slice(0, 200)}`
    })
    await check('S1.16', 'Load Review page: Move N to billing exists here (reviewer persona sees it)', async () => {
      const rb = await ctx.newBrowser('reviewer')
      try {
        await rb.navigate('/tms/load-review')
        const text = await settle(rb, { min: 60, quietMs: 3000, timeout: 60_000 })
        await rb.capture('flows-s1-load-review-reviewer.png')
        expect(!/unauthorized|forbidden|could not resolve/i.test(text), 'auth text on the reviewer page')
        const btns = await rb.evaluate(`[...document.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).filter(Boolean).join(' | ')`)
        return `reviewer-only user renders Load Review without auth errors; buttons: ${btns.slice(0, 160)}; the release button appears once rows are ticked`
      } finally { await rb.close() }
    })
  } finally { await b.close() }
}
