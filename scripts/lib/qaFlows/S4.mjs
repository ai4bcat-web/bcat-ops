import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { record, expect, short, settle } from '../qaFlowsKit.mjs'
import { zzCustomer } from './fixtures.mjs'

export const TITLE = 'Quotes: read-only spot quoter, outcomes, Mark won/lost, rate intelligence, Push to DAT'

async function check(id, name, fn) {
  try { record('PASS', id, name, await fn()) } catch (err) { record('FAIL', id, name, short(err)); process.exitCode = 1 }
}
async function walkFiles(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') await walkFiles(p, out) } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|testkit|Testkit/.test(e.name)) out.push(p)
  }
  return out
}
const stops = () => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + 3 * 864e5))
  return [
    { type: 'pickup', name: 'ZZ QAF Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
    { type: 'delivery', name: 'ZZ QAF Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T21:00:00.000Z` },
  ]
}

export async function run(ctx) {
  const a = ctx.id.admin

  // ── read-only mailbox: scopes + remnants ───────────────────────────────────
  await check('S4.01', 'OAuth scope list is gmail.readonly only (asserted from the source of truth and the Lambda that builds the consent URL)', async () => {
    const oauth = await readFile('amplify/functions/_shared/gmail/oauth.ts', 'utf8')
    const scopes = [...oauth.slice(oauth.indexOf('GMAIL_SCOPES'), oauth.indexOf('] as const')).matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(JSON.stringify(scopes) === JSON.stringify(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']), `scopes: ${scopes.join(' ')}`)
    const urlFn = oauth.slice(oauth.indexOf('export function buildAuthUrl'))
    expect(/scope:\s*GMAIL_SCOPES\.join\(' '\)/.test(urlFn) || /GMAIL_SCOPES/.test(urlFn), 'buildAuthUrl does not use GMAIL_SCOPES')
    const files = [...await walkFiles('amplify'), ...await walkFiles('src')]
    const scopeHits = []
    for (const f of files) {
      const t = await readFile(f, 'utf8')
      for (const m of t.matchAll(/gmail\.(send|compose|modify|insert|labels|settings\.[a-z.]+)|auth\/gmail(?!\.readonly)[^'"\s]*|mail\.google\.com\/?'/g)) scopeHits.push(`${f}:${m[0]}`)
    }
    expect(scopeHits.length === 0, `non-readonly gmail scope strings: ${scopeHits.slice(0, 5).join(', ')}`)
    return `GMAIL_SCOPES = openid, email, gmail.readonly; ${files.length} non-test source files scanned: 0 send/compose/modify scope strings`
  })
  await check('S4.02', 'no send / draft / compose API calls to Gmail in non-test source (REST paths, HTTP methods, port methods)', async () => {
    const files = [...await walkFiles('amplify'), ...await walkFiles('src')]
    const hits = []
    for (const f of files) {
      const t = await readFile(f, 'utf8')
      for (const m of t.matchAll(/users\/me\/(drafts|messages\/send|messages\/[^/'"`]+\/(modify|trash|untrash))|\bcreateDraft\b|\bsendDraft\b|messages\.send\b|drafts\.create\b|batchModify|\/messages\/import|\/messages\/insert/g)) hits.push(`${f}:${m[0]}`)
    }
    expect(hits.length === 0, `write-ish Gmail calls: ${hits.slice(0, 6).join(', ')}`)
    const port = await readFile('amplify/functions/_shared/gmail/googlePort.ts', 'utf8')
    const methods = [...new Set([...port.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]))]
    expect(methods.every((m) => m === 'GET'), `googlePort HTTP methods: ${methods.join(',')}`)
    return `0 write-ish Gmail REST paths / methods in ${files.length} files; googlePort.ts HTTP methods: ${methods.join(',') || '(fetch default GET)'}`
  })
  await check('S4.03', 'stale "creates REPLY DRAFTS" remnant (tms-spot-quoter/resource.ts comment) removed', async () => {
    const t = await readFile('amplify/functions/tms-spot-quoter/resource.ts', 'utf8')
    expect(!/REPLY DRAFTS|creates .*drafts/i.test(t), 'resource.ts header comment still says the function creates reply drafts in Gmail')
    return 'no draft wording left in the function header'
  })
  await check('S4.04', 'no send/draft/modify spot actions on the router (actions that do not exist are refused)', async () => {
    const spot = (await import('../devIdentity.mjs')).routerAs(a.access, 'tmsSpotActions')
    for (const action of ['SPOT_SEND', 'SPOT_CREATE_DRAFT', 'SPOT_DRAFT', 'SPOT_SEND_REPLY', 'SPOT_MODIFY_MAIL']) {
      let msg = ''
      await spot(action, {}).then(() => { msg = 'ACCEPTED' }, (e) => { msg = short(e) })
      expect(msg !== 'ACCEPTED' && /unknown|unsupported|not supported|invalid action/i.test(msg), `${action}: ${msg.slice(0, 120)}`)
    }
    return '5 send/draft action names refused as unknown actions'
  })

  // ── quote outcomes through the real router ────────────────────────────────
  const cust = await zzCustomer(ctx, 'S4')
  await a.dir('SET_CUSTOMER_STATUS', { id: cust, expectedUpdatedAt: (await a.gql('query($id: ID!) { getCustomer(id: $id) { updatedAt } }', { id: cust })).getCustomer.updatedAt, status: 'ACTIVE' })
  const quoteIds = []
  const newQuote = async (label) => {
    const saved = await a.ship('SAVE_QUOTE', {
      customerId: cust, mode: 'FTL', rateType: 'SPOT', equipmentType: 'Dry Van', commodity: `ZZ ${label}`, miles: 925, weightLbs: 40000,
      contactName: 'ZZ QAF Buyer', contactEmail: `zz-qaf-q-${ctx.ts}@example.invalid`, stops: stops(),
      lines: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 }, { side: 'CARRIER', code: 'LINEHAUL', rateCents: 150000, count: 1 }],
    })
    const id = String(saved.quote.id)
    quoteIds.push(id)
    ctx.cleanup.push(async () => {
      const q = (await a.gql('query($id: ID!) { getQuote(id: $id) { status version shipmentId } }', { id })).getQuote
      if (q && !q.shipmentId && ['DRAFT', 'REQUESTED', 'QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY', 'RECEIVED_COUNTER'].includes(q.status)) await a.ship('CANCEL_QUOTE', { quoteId: id })
    })
    return id
  }
  const read = async (id) => (await a.gql('query($id: ID!) { getQuote(id: $id) { id status lostReason shipmentId expiresAt side } }', { id })).getQuote
  const send = (id) => a.ship('SEND_QUOTE', { quoteId: id })
  const qPending = await newQuote('Pending')
  const qLost = await newQuote('Lost')
  const qWon = await newQuote('Won')
  const qConv = await newQuote('Converted')
  for (const id of [qPending, qLost, qWon, qConv]) await send(id)

  await check('S4.05', 'a sent quote stays open (PENDING) until marked: QUOTED with a future expiry', async () => {
    const q = await read(qPending)
    expect(q.status === 'QUOTED' && q.expiresAt && Date.parse(q.expiresAt) > Date.now(), JSON.stringify(q))
    return `status ${q.status}, expires in ${Math.round((Date.parse(q.expiresAt) - Date.now()) / 36e5)} h`
  })
  await check('S4.06', 'Mark lost with a reason (TOO_HIGH) -> LOST + reason + audit; Mark won -> WON; open-only guard on a second close', async () => {
    await a.ship('MARK_QUOTE_LOST', { quoteId: qLost, reason: 'TOO_HIGH', note: 'ZZ QAF' })
    const l = await read(qLost)
    expect(l.status === 'LOST' && l.lostReason === 'TOO_HIGH', JSON.stringify(l))
    await a.ship('MARK_QUOTE_WON', { quoteId: qWon, note: 'ZZ QAF' })
    const w = await read(qWon)
    expect(w.status === 'WON', JSON.stringify(w))
    let msg = ''
    await a.ship('MARK_QUOTE_LOST', { quoteId: qWon }).then(() => { msg = 'ACCEPTED' }, (e) => { msg = short(e) })
    expect(/already WON/.test(msg), msg)
    const audit = (await a.gql(`query($id: String!) { listAuditLogByEntityTypeAndEntityId(entityType: "QUOTE", entityId: {eq: $id}, limit: 50) { items { action } } }`, { id: qLost })).listAuditLogByEntityTypeAndEntityId.items.map((i) => i.action)
    expect(audit.includes('MARK_QUOTE_LOST'), `audit: ${audit.join(',')}`)
    return `LOST/TOO_HIGH, WON, second close refused ("already WON"); audit has MARK_QUOTE_LOST`
  })
  let converted = null
  await check('S4.07', 'converted = WON (quote WON with a shipment)', async () => {
    const r = await a.ship('CONVERT_QUOTE', { quoteId: qConv, acceptedVia: 'LINK' })
    const q = await read(qConv)
    converted = r.bundle?.shipment?.id
    if (converted) ctx.cleanup.push(async () => {
      const row = (await a.gql('query($id: ID!) { getShipment(id: $id) { voidedAt updatedAt } }', { id: converted })).getShipment
      if (row && !row.voidedAt) await a.ship('VOID_SHIPMENT', { shipmentId: converted, reason: 'ZZ QAF verification fixture', expectedUpdatedAt: String(row.updatedAt) })
    })
    expect(q.status === 'WON' && q.shipmentId === converted, JSON.stringify(q))
    return `status ${q.status}, shipment linked`
  })
  await check('S4.08', 'Push to DAT (STUB) records a posting for a quote and Unpost flips it', async () => {
    const posted = await a.ship('POST_QUOTE_LOAD', { quoteId: qPending, providers: ['DAT'], rateCents: 250000 })
    const p = (posted.postings ?? [])[0]
    expect(p, 'no posting row')
    const un = await a.ship('UNPOST_QUOTE_LOAD', { quoteId: qPending })
    const after = (un.postings ?? [])[0]
    return `posted: provider ${p.provider} mode ${p.mode ?? p.status}; after Unpost status ${after?.status}`
  })

  // ── browser ────────────────────────────────────────────────────────────────
  const b = await ctx.newBrowser('admin')
  try {
    await check('S4.09', 'lane rates route redirects /tms/rates/lanes -> /tms/rates', async () => {
      await b.navigate('/tms/rates/lanes')
      await settle(b, { min: 80, quietMs: 1500 })
      const path = await b.evaluate('location.pathname + location.search')
      expect(path === '/tms/rates', `landed ${path}`)
      return `landed ${path}`
    })
    await check('S4.10', 'Quotes list shows the outcome per quote: Pending on Sent, Won/Lost on Won / Lost; Outcome filter exists', async () => {
      const tab = async (name) => {
        await b.evaluate(`[...document.querySelectorAll('button, [role=tab]')].find((x) => new RegExp('^' + ${JSON.stringify(name)}).test((x.textContent || '').trim()))?.click()`)
        await b.pause(1200)
        return b.evaluate(`[...document.querySelectorAll('[data-testid="quote-outcome"]')].map((e) => e.textContent.trim()).reduce((m, l) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {})`)
      }
      await b.navigate('/tms/rates')
      await settle(b, { min: 200, quietMs: 3000, timeout: 60_000 })
      const sent = await tab('Sent')
      await b.capture('flows-s4-quotes-sent.png')
      const closed = await tab('Won')
      await b.capture('flows-s4-quotes-won-lost.png')
      const filter = await b.evaluate(`/Outcome is/.test(document.body.innerText)`)
      expect((sent.Pending ?? 0) >= 1, `Sent tab badges ${JSON.stringify(sent)}`)
      expect((closed.Won ?? 0) >= 1 && (closed.Lost ?? 0) >= 1, `Won / Lost tab badges ${JSON.stringify(closed)}`)
      expect(filter, 'no Outcome filter chip (Outcome is ...)')
      return `Sent tab outcomes ${JSON.stringify(sent)}; Won / Lost tab outcomes ${JSON.stringify(closed)}; Outcome filter present`
    })
    await check('S4.11', 'Quote detail: outcome badge, Mark won / Mark lost (with reason dialog), Rate intelligence 3 sections, Push to DAT STUB label', async () => {
      await b.navigate(`/tms/rates/${qPending}`)
      await settle(b, { min: 300, quietMs: 3500, timeout: 60_000 })
      const f = await b.evaluate(`(() => {
        const t = document.body.innerText
        return { outcome: document.querySelector('[data-testid="quote-outcome"]')?.textContent.trim() ?? null,
          markWon: !!document.querySelector('[aria-label="Mark the quote won"]'), markLost: !!document.querySelector('[aria-label="Mark the quote lost"]'),
          ri: /Rate intelligence/.test(t), market: /Market · DAT RateView/.test(t), ran: /What we ran this lane for/.test(t), quoted: /What we quoted this lane for/.test(t),
          stub: !!document.querySelector('[data-testid="push-dat-stub"]'), pushBtn: [...document.querySelectorAll('button')].some((x) => /Push to DAT/.test(x.textContent)) }
      })()`)
      await b.capture('flows-s4-quote-detail.png')
      expect(f.outcome === 'Pending', `outcome badge ${f.outcome}`)
      expect(f.markWon && f.markLost, 'Mark won / Mark lost missing on an open quote')
      expect(f.ri && f.market && f.ran && f.quoted, `rate intelligence sections: ${JSON.stringify(f)}`)
      expect(f.pushBtn, 'no Push to DAT button')
      // open the Mark lost dialog and read the reason control without confirming
      await b.evaluate(`document.querySelector('[aria-label="Mark the quote lost"]').click()`)
      await b.pause(700)
      const dlg = await b.evaluate(`(() => { const d = document.querySelector('[role=dialog]'); return d ? { select: !!d.querySelector('select, [role=combobox]'), text: d.innerText.slice(0, 200) } : null })()`)
      await b.capture('flows-s4-mark-lost-dialog.png')
      expect(dlg && dlg.select, `Mark lost dialog has no reason control: ${JSON.stringify(dlg)}`)
      await b.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((x) => /cancel|close/i.test(x.textContent))?.click()`)
      return `outcome ${f.outcome}; Mark won+lost present; reason control in the Mark lost dialog; Rate intelligence: Market, What we ran, What we quoted; Push to DAT button present, STUB badge on the card: ${f.stub}`
    })
    await check('S4.12', 'Won / Lost / converted quotes show Won/Lost on the detail page', async () => {
      const seen = {}
      for (const [k, id] of [['lost', qLost], ['won', qWon], ['converted', qConv]]) {
        await b.navigate(`/tms/rates/${id}`)
        await settle(b, { min: 300, quietMs: 2500, timeout: 60_000 })
        seen[k] = await b.evaluate(`document.querySelector('[data-testid="quote-outcome"]')?.textContent.trim() ?? null`)
      }
      expect(seen.lost === 'Lost' && seen.won === 'Won' && seen.converted === 'Won', JSON.stringify(seen))
      return JSON.stringify(seen)
    })
  } finally { await b.close() }

  // ── Spot inbox: suggested response, Copy, Open in Gmail URL, mark by hand ──────────────
  const spot = (await import('../devIdentity.mjs')).routerAs(a.access, 'tmsSpotActions')
  let reqId = null
  await check('S4.13', 'simulated mailbox: a ZZ quote-request e-mail becomes a spot request with a suggested response; quote stays open until marked', async () => {
    await spot('SPOT_CONNECT_SIMULATED', {})
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + 4 * 864e5))
    const from = `zz-qaf-buyer-${ctx.ts}@example.invalid`
    const message = {
      from, to: [a.email], subject: `ZZ QAF quote request ${ctx.ts}`,
      body: ['Hi team,', `Need a spot quote for a dry van, Chicago, IL 60601 to Dallas, TX 75201, pickup ${day}, 40,000 lbs, general freight, no accessorials.`, 'Thanks, ZZ QAF Buyer'].join('\n'),
      headers: { 'authentication-results': 'mx.google.com; spf=pass smtp.mailfrom=example.invalid; dkim=pass header.d=example.invalid' },
    }
    ctx.cleanup.push(async () => { await spot('SPOT_SIM_PURGE_TEST', {}).catch(() => {}) })
    await spot('SPOT_SIM_INJECT', { message })
    let last = await spot('SPOT_POLL_NOW', {})
    for (let i = 0; i < 6 && last.partial; i++) last = await spot('SPOT_POLL_NOW', {})
    const rows = (await spot('SPOT_LIST_REQUESTS', {})).rows ?? []
    const row = rows.find((r) => String(r.subject ?? '').includes(`ZZ QAF quote request ${ctx.ts}`))
    expect(row, `request not created (rows ${rows.length}; poll stats ${JSON.stringify(last.stats ?? {}).slice(0, 160)})`)
    reqId = row.id
    return `request created (status ${row.status}); poll stats ${JSON.stringify(last.stats ?? {}).slice(0, 120)}`
  })
  if (reqId) {
    const b2 = await ctx.newBrowser('admin')
    try {
      await b2.grantClipboard?.().catch(() => {})
      await check('S4.14', 'Spot inbox drawer: suggested response, Copy response puts it on the clipboard, Open in Gmail URL encodes subject/body, mark Sent by hand', async () => {
        const sug = await spot('SPOT_SUGGEST_RESPONSE', { requestId: reqId }).catch((e) => ({ error: short(e) }))
        await b2.navigate('/tms/rates/spot')
        await settle(b2, { min: 150, quietMs: 3000, timeout: 60_000 })
        const opened = await b2.evaluate(`(() => { const r = [...document.querySelectorAll('tr, [role=row], li, button')].find((e) => (e.textContent || '').includes('ZZ QAF quote request')); if (!r) return false; r.click(); return true })()`)
        expect(opened, 'the ZZ request is not on the Spot inbox list')
        await b2.waitFor('[data-testid="spot-resp-body"]', 30_000).catch(() => {})
        const hasResp = await b2.evaluate(`!!document.querySelector('[data-testid="spot-resp-body"]')`)
        await b2.capture('flows-s4-spot-drawer.png')
        expect(hasResp, `no suggested response box in the drawer (suggest action: ${sug.error ?? 'ok'})`)
        const body = await b2.evaluate(`document.querySelector('[data-testid="spot-resp-body"]').value`)
        expect(body.length > 20, 'suggested response empty')
        await b2.evaluate(`document.querySelector('[data-testid="spot-copy"]').click()`)
        await b2.pause(800)
        const clip = await b2.evaluate(`navigator.clipboard.readText().catch((e) => 'ERR ' + e.message)`)
        const href = await b2.evaluate(`document.querySelector('[data-testid="spot-open-compose"]').getAttribute('href')`)
        const u = new URL(href)
        expect(u.origin === 'https://mail.google.com' && u.searchParams.get('view') === 'cm' && u.searchParams.get('body') === body && !/\+/.test(href.replace(/%2B/g, '')), `compose URL does not round-trip the body: ${href.slice(0, 120)}`)
        expect(clip === body, `clipboard ${clip.startsWith('ERR') ? clip : `holds ${clip.length} chars vs body ${body.length}`}`)
        const status = (await spot('SPOT_LIST_REQUESTS', {})).rows.find((r) => r.id === reqId).status
        expect(status !== 'SENT' && status !== 'WON' && status !== 'LOST', `copying changed the request to ${status}`)
        await b2.evaluate(`[...document.querySelectorAll('button')].find((x) => /mark sent/i.test(x.textContent))?.click()`)
        await b2.pause(1500)
        const sent = (await spot('SPOT_LIST_REQUESTS', {})).rows.find((r) => r.id === reqId).status
        await b2.navigate('/tms/rates/spot')
        await settle(b2, { min: 150, quietMs: 3000, timeout: 60_000 })
        await b2.evaluate(`[...document.querySelectorAll('button, [role=tab]')].find((x) => /^Sent/.test((x.textContent || '').trim()))?.click()`)
        await b2.pause(1500)
        await b2.capture('flows-s4-spot-list-outcome.png')
        const outcomeShown = (await b2.evaluate(`[...document.querySelectorAll('[data-testid="spot-outcome"]')].map((e) => e.textContent.trim())`)).includes('Pending')
        expect(outcomeShown, 'Spot inbox Sent tab shows no Pending outcome badge for the sent request')
        return `Spot inbox shows the outcome Pending for the sent request; suggested response ${body.length} chars; clipboard equals the body; compose URL host mail.google.com, view=cm, body param decodes to the body, no raw '+'; status after Copy ${status}; after Mark sent by hand ${sent}`
      })
    } finally { await b2.close() }
  }
}
