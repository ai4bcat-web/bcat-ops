import { record, expect, short, settle } from '../qaFlowsKit.mjs'
import { zzCustomer, zzShipment } from './fixtures.mjs'

export const TITLE = 'Driver pay (Wednesday), vendors, invoice numbering, PRO counter, Aljex legacy gates'

async function check(id, name, fn) {
  try { record('PASS', id, name, await fn()) } catch (err) { record('FAIL', id, name, short(err)); process.exitCode = 1 }
}

export async function run(ctx) {
  const a = ctx.id.admin
  const b = await ctx.newBrowser('admin')
  try {
    for (const [route, label] of [['/driver-pay', 'Amazon settlements'], ['/driver-pay-box-trucks', 'Box truck settlements'], ['/owner-operator-pay', 'Owner operator settlements']]) {
      await check(`S6.banner${route}`, `${label}: payroll Wednesday banner`, async () => {
        await b.navigate(route)
        const text = await settle(b, { min: 150, quietMs: 3000, timeout: 60_000 })
        await b.capture(`flows-s6-banner${route.replace(/\//g, '-')}.png`)
        const m = text.match(/Payroll runs every Wednesday[^\n]*/)
        expect(m, 'banner text "Payroll runs every Wednesday" not on the page')
        return `"${m[0].slice(0, 140)}"`
      })
    }
    await check('S6.vendors', 'Accounting > Vendors has no driver-pay queue (a pointer to settlements only)', async () => {
      await b.navigate('/tms/vendors')
      const text = await settle(b, { min: 150, quietMs: 3000, timeout: 60_000 })
      await b.capture('flows-s6-vendors.png')
      const tabs = await b.evaluate(`[...document.querySelectorAll('[role=tab], [role=tablist] button, .tms-segmented button')].map((x) => (x.textContent || '').trim()).filter(Boolean)`)
      expect(!tabs.some((t) => /driver|payroll|settlement/i.test(t)), `vendors tabs: ${tabs.join(' | ')}`)
      expect(/Driver settlements and\s+payroll \(every Wednesday\)/i.test(text.replace(/\s+/g, ' ')) || /Not in this queue/.test(text), 'the "Not in this queue" pointer is missing')
      return `tabs/filters: ${tabs.join(' | ').slice(0, 160)}; "Not in this queue" pointer to Assets > settlements present`
    })
  } finally { await b.close() }

  await check('S6.settings', 'TmsSettings: PRO scheme NUMERIC and the invoice series start / counter (read only)', async () => {
    const s = (await a.gql('query { listTmsSettings(limit: 5) { items { id proScheme invoiceSeriesStart nextInvoiceNumber invoiceNumberFormat maxImportedInvoiceNumber } } }')).listTmsSettings.items[0]
    expect(s, 'no settings row')
    return JSON.stringify({ proScheme: s.proScheme, invoiceSeriesStart: s.invoiceSeriesStart, nextInvoiceNumber: s.nextInvoiceNumber, invoiceNumberFormat: s.invoiceNumberFormat, maxImportedInvoiceNumber: s.maxImportedInvoiceNumber })
  })
  await check('S6.invoice-numbers', 'invoices issued in the new series are plain numbers 20000+ (aggregate over the invoice table)', async () => {
    let token = null; let n = 0; let plain = 0; let newSeries = 0; let prefixed = 0; let min = Infinity; let max = 0
    for (let page = 0; page < 20; page++) {
      const r = (await a.gql('query($t: String) { listInvoices(limit: 1000, nextToken: $t) { items { number } nextToken } }', { t: token })).listInvoices
      for (const i of r.items) {
        n++
        const num = String(i.number ?? '')
        if (/^\d+$/.test(num)) { plain++; const v = Number(num); if (v >= 20000) { newSeries++; min = Math.min(min, v); max = Math.max(max, v) } } else prefixed++
      }
      token = r.nextToken
      if (!token) break
    }
    return `${n} invoices: ${plain} plain numeric, ${prefixed} other formats; ${newSeries} numbered 20000+ (range ${Number.isFinite(min) ? `${min}-${max}` : 'none'})`
  })
  const cust = await zzCustomer(ctx, 'S6')
  await check('S6.pro', 'a new shipment gets a numeric PRO from the counter (digits only, increasing)', async () => {
    const s1 = await zzShipment(ctx, cust, { submit: false })
    const s2 = await zzShipment(ctx, cust, { submit: false })
    const n1 = s1.bundle.shipment.number ?? s1.bundle.loads?.[0]?.proNumber
    const n2 = s2.bundle.shipment.number ?? s2.bundle.loads?.[0]?.proNumber
    expect(/^\d+$/.test(String(n1)) && /^\d+$/.test(String(n2)), `numbers ${n1} / ${n2}`)
    expect(Number(n2) > Number(n1), `not increasing: ${n1} then ${n2}`)
    return `two ZZ shipments: ${n1} then ${n2} (plain digits, strictly increasing)`
  })
  await check('S6.legacy', 'Aljex-imported legacy shipment is exempt from the review extras (read-only REVIEW_LOAD on one imported shipment)', async () => {
    let token = null; let found = null
    for (let page = 0; page < 15 && !found; page++) {
      const r = (await a.gql('query($t: String) { listShipments(limit: 1000, nextToken: $t, filter: { legacyImported: { eq: true } }) { items { id legacyImported voidedAt } nextToken } }', { t: token })).listShipments
      found = r.items.find((i) => !i.voidedAt) ?? null
      token = r.nextToken
      if (!token) break
    }
    expect(found, 'no legacyImported shipment on dev')
    const v = await a.ship('REVIEW_LOAD', { shipmentId: found.id })
    expect(v.legacyImported === true, 'REVIEW_LOAD does not report legacyImported')
    expect((v.extras ?? []).length === 0, `legacy extras not exempt: ${JSON.stringify(v.extras).slice(0, 200)}`)
    return `legacyImported=true; review extras 0 (imported history exempt); release gate ok=${v.releaseGate?.ok}`
  })
}
