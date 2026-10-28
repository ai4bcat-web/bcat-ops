/**
 * Step H live verification against the DEV stack.
 *
 * Throwaway, and the sibling of `devVerifyAr.mjs` and `devVerifyAp.mjs`: it builds
 * its own customers, its own carriers and its own shipments, then drives the whole
 * of step H through the DEPLOYED router and the DEPLOYED public Function URL —
 * quote → link → counter → accept → convert → revert, the credit block, the other
 * sell rungs, the carrier offer round from request to booking, the expiry sweep and
 * the lane history — asserting the observable result of every step. It touches no
 * copied customer, carrier, load or quote, it never prints a password or a whole
 * token, and it refuses to run against anything but the dev API.
 *
 *   BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyQuotes.mjs
 */
import { authenticateTmsUser } from './lib/tmsAuth.mjs'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
/** The dev tracking-api Function URL: `GET /q/<token>` and `POST /q/<token>/respond`. */
const PUBLIC_API = 'https://jk65s5nfkj2sfnnoang4huvbvq0bsruo.lambda-url.us-east-1.on.aws'

const outputs = {
  auth: {
    user_pool_id: DEV_POOL,
    user_pool_client_id: DEV_CLIENT,
    aws_region: 'us-east-1',
    username_attributes: ['email'],
  },
  data: { url: DEV_API, aws_region: 'us-east-1', default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

const results = []
function ok(name, detail) { results.push({ ok: true, name, detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
function bad(name, detail) { results.push({ ok: false, name, detail }); console.log(`FAIL  ${name} — ${detail}`) }

let token = ''
async function gql(query, variables) {
  const res = await fetch(DEV_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}

const router = (field) => async (action, input) => {
  const data = await gql(
    `mutation A($action: String!, $input: AWSJSON!) { ${field}(action: $action, input: $input) }`,
    { action, input: JSON.stringify(input) },
  )
  return JSON.parse(data[field])
}
const shipAction = router('tmsShipmentActions')
const dirAction = router('tmsDirectoryActions')
const carrierAction = router('tmsCarrierActions')

/** Run a call that must be refused, and check the refusal says what it should. */
async function refuses(name, pattern, run) {
  try {
    await run()
    bad(name, 'it was allowed')
  } catch (err) {
    const message = String(err.message ?? err)
    if (pattern.test(message)) ok(name, message.slice(0, 140))
    else bad(name, `refused for the wrong reason: ${message.slice(0, 200)}`)
  }
}

// ── the public link, which carries no sign-in at all ─────────────────────────

/** `GET /q/<token>` as the customer's browser makes it: no credentials. */
async function publicGet(path) {
  const res = await fetch(`${PUBLIC_API}${path}`, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
}

/** `POST /q/<token>/respond` as the public page sends it. */
async function publicPost(path, payload) {
  const res = await fetch(`${PUBLIC_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
}

/** A token is a secret: eight characters is enough to tell two of them apart. */
const tok8 = (value) => (value ? String(value).slice(0, 8) : 'none')

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** `215000` → `'2,150.00'`: the shape a leak would take in an e-mail or a page. */
const dollars = (cents) => (cents == null ? '' : `${Math.floor(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`)

/** `4340` → `'43.4%'`, which is how `priceQuoteLines` words a margin. */
const percent = (bps) => (bps == null ? '' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`)

// ── reads straight off the models, which every signed-in user may do ─────────

const QUOTE_FIELDS = `
  id side status quoteOpen groupId quoteDate customerId customerName contactName contactEmail
  carrierId carrierName carrierEmail shipmentId shipmentNumber orderId loadId loadNumber
  mode rateType equipmentType laneKey laneKey3 pickupAppt deliveryAppt commodity weightLbs miles
  amountCents customerRateCents targetBuyCents topSpendCents marginBps bookNowRateCents
  counterCents counterBy rounds expiresAt linkToken linkVersion requestCount
  sentAt sentTo sendCount lastSendStatus respondedAt response responderName responderEmail
  acceptedVia lostReason lostNote wonAt closedAt duplicatedFromId pricingWarnings
  customerMessage internalNotes createdBy updatedBy version
`

async function getQuote(id) {
  const data = await gql(`query G($id: ID!) { getQuote(id: $id) { ${QUOTE_FIELDS} } }`, { id })
  if (!data.getQuote) throw new Error(`No Quote row for ${id}`)
  return data.getQuote
}

async function getCustomer(id) {
  const data = await gql('query G($id: ID!) { getCustomer(id: $id) { id name status active updatedAt } }', { id })
  return data.getCustomer
}

async function getLaneSample(loadId) {
  const data = await gql(
    `query G($id: ID!) { getLaneRateSample(id: $id) {
      id laneKey laneKey3 date loadId shipmentId orderId customerId customerName carrierId carrierName
      assignmentKind mode rateType equipmentType miles customerRateCents revenueCents carrierRateCents
      costCents profitCents marginBps loadStatus excluded source sampledAt version
    } }`,
    { id: `lrs:${loadId}` },
  )
  return data.getLaneRateSample
}

/** One page of a secondary index, the way `apiClient.listTrackingIndex` asks for it. */
async function indexQuery(name, decls, args, variables, fields, limit = 100) {
  const data = await gql(
    `query Q(${decls}) { ${name}(${args}, limit: ${limit}) { items { ${fields} } nextToken } }`,
    variables,
  )
  return data[name]?.items ?? []
}

const legsOf = (bundle) => bundle.loadCarriers ?? bundle.carriers ?? []

/**
 * Every leaf of a public payload, so a leak can be asserted by VALUE rather than by
 * the absence of a field name somebody might rename tomorrow.
 */
function leaves(value, out = []) {
  if (value == null) return out
  if (Array.isArray(value)) { for (const item of value) leaves(item, out); return out }
  if (typeof value === 'object') { for (const item of Object.values(value)) leaves(item, out); return out }
  out.push(value)
  return out
}

/** The keys a payload carries at any depth — the other half of the leak check. */
function keysOf(value, out = []) {
  if (value == null || typeof value !== 'object') return out
  if (Array.isArray(value)) { for (const item of value) keysOf(item, out); return out }
  for (const [key, item] of Object.entries(value)) { out.push(key); keysOf(item, out) }
  return out
}

/**
 * What a public payload must not be carrying. `numbers` are matched against both the
 * parsed leaves and the raw text, `texts` against the raw text, `keys` against every
 * key at every depth. Returns the list of things that leaked.
 */
function leaked(payload, raw, { numbers = [], texts = [], keys = [] }) {
  const found = []
  const values = leaves(payload)
  const present = new Set(keysOf(payload))
  for (const [label, n] of numbers) {
    if (n == null) continue
    if (values.includes(n) || raw.includes(String(n))) found.push(`${label}=${n}`)
  }
  for (const [label, t] of texts) {
    if (!t) continue
    if (raw.toLowerCase().includes(String(t).toLowerCase())) found.push(`${label}`)
  }
  for (const key of keys) if (present.has(key)) found.push(`field ${key}`)
  return found
}

/** The caller's own claims, read out of the token we already hold. Never printed. */
function callerClaims(idToken) {
  try {
    const payload = idToken.split('.')[1]
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    const raw = claims['cognito:groups']
    const groups = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()) : []
    return { email: String(claims.email ?? ''), groups }
  } catch {
    return { email: '', groups: [] }
  }
}

async function main() {
  const auth = await authenticateTmsUser(outputs)
  token = auth.token
  if (auth.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')

  const stamp = Date.now()
  const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10)
  const tomorrow = day(1)
  const pickupAppt = `${tomorrow}T13:00:00.000Z`
  const deliveryAppt = `${tomorrow}T23:00:00.000Z`
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString()

  const claims = callerClaims(token)
  // `authorize()` reads exactly this: owner or ADMIN, else the page group.
  const isAdmin = claims.groups.includes('ADMIN') || claims.groups.includes('admin')
  console.log(`signed in as ${claims.email || '(email not in the token)'} · groups: ${claims.groups.join(', ') || 'none'}`)

  // What is left behind for the lead to record, filled in as it is created.
  const made = { customers: [], carriers: [], shipments: [], quotes: [] }
  const noteQuote = (id, what) => { made.quotes.push(`${id} (${what})`); return id }
  const noteShipment = (bundle, label) => {
    made.shipments.push({ id: String(bundle.shipment.id), number: String(bundle.shipment.number ?? ''), label })
    return String(bundle.shipment.id)
  }

  /**
   * Cancel, then soft-delete: a BOOKED shipment refuses the delete outright, and a
   * shipment that is already gone is left alone. Declared out here because the
   * cleanup runs in the `finally`, whatever happened in the middle.
   */
  const retireShipment = async (id, label) => {
    for (const step of ['cancel', 'delete']) {
      const current = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: id }).catch(() => null)
      if (!current || current.shipment.deletedAt) return
      const args = { shipmentId: id, expectedUpdatedAt: current.shipment.updatedAt, reason: 'dev verification fixture' }
      await shipAction(
        step === 'cancel' ? 'SET_SHIPMENT_STATUS' : 'DELETE_SHIPMENT',
        step === 'cancel' ? { ...args, status: 'CANCELED' } : args,
      ).catch((err) => console.log(`  (${label} ${step} skipped: ${String(err.message).slice(0, 90)})`))
    }
  }

  try {
    // ── fixtures ────────────────────────────────────────────────────────────
    /*
     * A lead, not an account: SEND_QUOTE is what moves a prospect to QUOTED, and
     * that move is one of the things being verified. The pricing defaults carry a
     * margin mode so the target buy is a real number, and a minimum profit so the
     * ‡ warnings have something to fire on.
     */
    const customer = (await dirAction('UPSERT_CUSTOMER', {
      name: `ZZ Quote Verification ${stamp}`,
      status: 'NEW',
      mcNumber: `6${String(stamp).slice(-6)}`,
      billingEmail: 'quote-verification@example.invalid',
      creditLimitCents: 500000000,
      paymentTermsDays: 30,
      pricingDefaults: { mode: 'MARGIN', defaultBps: 2500, minProfitCents: 50000, maxProfitCents: 2000000 },
      quotingDefaults: { defaultMode: 'FTL', hoursToQuote: 24 },
      notes: 'Dev-only Step H verification fixture. Safe to delete.',
    }).then((r) => r.customer ?? r))
    made.customers.push(`${customer.name} (${customer.id})`)
    console.log(`fixture customer: ${customer.name} (${customer.id}) status ${customer.status}`)

    /* The second customer exists to be refused: everything else about it is fine. */
    const heldCustomer = (await dirAction('UPSERT_CUSTOMER', {
      name: `ZZ Quote Credit Hold ${stamp}`,
      status: 'ACTIVE',
      mcNumber: `5${String(stamp).slice(-6)}`,
      billingEmail: 'quote-credit-hold@example.invalid',
      creditLimitCents: 500000000,
      creditHoldFlag: true,
      paymentTermsDays: 30,
      notes: 'Dev-only Step H verification fixture (credit hold). Safe to delete.',
    }).then((r) => r.customer ?? r))
    made.customers.push(`${heldCustomer.name} (${heldCustomer.id})`)
    console.log(`fixture customer: ${heldCustomer.name} (${heldCustomer.id}) hold=${heldCustomer.creditHoldFlag}`)

    /*
     * Auto liability and cargo covering the pickup are hard blocks on BOOK_CARRIER,
     * and ACCEPT_OFFER is BOOK_CARRIER: both fixture carriers hold real cover rather
     * than booking past the gate. Two of them, because one offer round has to have a
     * loser for the sibling close to be observable.
     */
    const makeCarrier = async (suffix, digit) => {
      const row = await carrierAction('UPSERT_CARRIER', {
        name: `ZZ Quote Carrier ${suffix} ${stamp}`,
        type: 'TL',
        status: 'ACTIVE',
        mcNumber: `${digit}${String(stamp).slice(-6)}`,
        dotNumber: `${digit}${String(stamp).slice(-6)}`,
        dispatcherEmail: `quote-carrier-${suffix.toLowerCase()}@example.invalid`,
        accountingEmail: `quote-carrier-${suffix.toLowerCase()}@example.invalid`,
        insurancePolicies: [
          { type: 'AUTO_LIABILITY', company: 'Verification Mutual', policyNumber: `AL-${suffix}-${stamp}`, limitCents: 100000000, expiresAt: nextYear },
          { type: 'CARGO', company: 'Verification Mutual', policyNumber: `CG-${suffix}-${stamp}`, limitCents: 10000000, expiresAt: nextYear },
        ],
        notes: 'Dev-only Step H verification fixture. Safe to delete.',
      }).then((r) => r.carrier ?? r)
      made.carriers.push(`${row.name} (${row.id})`)
      console.log(`fixture carrier: ${row.name} (${row.id}) status ${row.status}`)
      return row
    }
    const carrierA = await makeCarrier('A', 4)
    const carrierB = await makeCarrier('B', 3)

    /* A carrier booked onto a fixture has no paperwork in the bucket; those are
     * warnings, and acknowledging them is the booker's real path. */
    const BOOKING_ACKS = [
      'MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT',
      'INSURANCE_UNVERIFIED',
      'MISSING_REQUIRED_FIELD:COMMODITY', 'MISSING_REQUIRED_FIELD:DESCRIPTION',
      'MISSING_REQUIRED_FIELD:VALUE', 'MISSING_REQUIRED_FIELD:WEIGHT',
    ]

    const stopsFor = (label) => ([
      {
        type: 'pickup',
        name: `Verify Shipper ${label}`,
        city: 'Chicago, IL',
        address: { city: 'Chicago', state: 'IL', zip: '60601' },
        appt: pickupAppt,
      },
      {
        type: 'delivery',
        name: `Verify Receiver ${label}`,
        city: 'Dallas, TX',
        address: { city: 'Dallas', state: 'TX', zip: '75201' },
        appt: deliveryAppt,
      },
    ])

    /** A priced, submitted FTL fixture of our own, built the ordinary way. */
    const makeShipment = async (label, customerRateCents) => {
      let b = await shipAction('CREATE_SHIPMENT', { customerId: customer.id })
      const id = b.shipment.id
      noteShipment(b, label)
      b = await shipAction('SAVE_ORDER_FORM', {
        shipmentId: id,
        expectedUpdatedAt: b.shipment.updatedAt,
        order: { mode: 'FTL', equipmentType: 'Dry Van' },
        stops: stopsFor(label),
        charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: customerRateCents, count: 1 }],
        loadFields: { miles: 925, weight: 40000, commodity: 'Verification freight' },
      })
      await shipAction('SUBMIT_ORDER', { shipmentId: id, expectedUpdatedAt: b.shipment.updatedAt })
      b = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: id })
      console.log(`fixture shipment ${b.shipment.number} (${id}) — ${label}`)
      return b
    }



    // ════════════════════════════════════════════════════════════════════════
    // SELL SIDE
    // ════════════════════════════════════════════════════════════════════════

    const INTERNAL_NOTE = `ZZ-INTERNAL-${stamp} target buy agreed with the desk`
    const CUSTOMER_MESSAGE = 'Rates are good through the end of the week.'

    // ── SAVE_QUOTE ──────────────────────────────────────────────────────────
    const saved = await shipAction('SAVE_QUOTE', {
      customerId: customer.id,
      mode: 'FTL',
      rateType: 'SPOT',
      equipmentType: 'Dry Van',
      commodity: 'Verification freight',
      miles: 925,
      weightLbs: 40000,
      contactName: 'Verification Buyer',
      contactEmail: 'quote-buyer@example.invalid',
      customerMessage: CUSTOMER_MESSAGE,
      stops: stopsFor('Quote'),
      // Σ of the CUSTOMER lines is the quote's number; the CARRIER line is our own
      // estimate of the buy and must never be part of it.
      lines: [
        { side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 },
        { side: 'CUSTOMER', code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 15000, count: 1 },
        { side: 'CARRIER', code: 'LINEHAUL', rateCents: 150000, count: 1 },
      ],
    })
    const quoteId = noteQuote(String(saved.quote.id), 'sell quote, converted')
    const priced = saved.pricing ?? {}
    if (quoteId && saved.quote.quoteDate && saved.quote.status === 'DRAFT' && saved.quote.quoteOpen === 'OPEN' && priced.amountCents === 265000) {
      ok('SAVE_QUOTE creates a numbered DRAFT and prices it', `${quoteId} ${saved.quote.status} amount ${priced.amountCents} target buy ${priced.targetBuyCents} margin ${priced.marginBps}bps top spend ${priced.topSpendCents}`)
    } else {
      bad('SAVE_QUOTE creates a numbered DRAFT and prices it', JSON.stringify({ id: quoteId, status: saved.quote.status, pricing: priced }).slice(0, 240))
    }

    // 265000 is the two CUSTOMER lines; the 150000 CARRIER estimate is not in it.
    if (saved.quote.amountCents === 265000 && priced.targetBuyCents === 198750 && priced.marginBps === 4340) {
      ok('the quote number is Σ of the CUSTOMER lines, with the buy estimate left out', `amount ${saved.quote.amountCents} target buy ${priced.targetBuyCents} margin ${priced.marginBps}bps`)
    } else {
      bad('the quote number is Σ of the CUSTOMER lines', JSON.stringify({ amountCents: saved.quote.amountCents, targetBuyCents: priced.targetBuyCents, marginBps: priced.marginBps }))
    }

    await refuses('an edit under a stale expectedVersion is refused', /was changed by someone else/i, () =>
      shipAction('SAVE_QUOTE', { quoteId, expectedVersion: 0, internalNotes: 'stale write' }))

    const edited = await shipAction('SAVE_QUOTE', {
      quoteId,
      expectedVersion: saved.quote.version,
      internalNotes: INTERNAL_NOTE,
    })
    if (edited.quote.version === saved.quote.version + 1 && edited.quote.internalNotes === INTERNAL_NOTE) {
      ok('an edit under the live version is taken and bumps it', `version ${saved.quote.version} → ${edited.quote.version}`)
    } else {
      bad('an edit under the live version', JSON.stringify({ version: edited.quote.version, internalNotes: edited.quote.internalNotes }).slice(0, 200))
    }

    // ── SEND_QUOTE ──────────────────────────────────────────────────────────
    const sent = await shipAction('SEND_QUOTE', {
      quoteId,
      via: 'EMAIL',
      message: CUSTOMER_MESSAGE,
      to: ['quote-buyer@example.invalid'],
    })
    const sentQuote = await getQuote(quoteId)
    if (sentQuote.status === 'QUOTED' && sentQuote.linkToken && sentQuote.expiresAt && sentQuote.linkVersion === 1) {
      ok('SEND_QUOTE moves the quote to QUOTED, mints a link and starts the clock', `${sentQuote.status} link:${tok8(sentQuote.linkToken)} expires ${sentQuote.expiresAt}`)
    } else {
      bad('SEND_QUOTE moves the quote to QUOTED', JSON.stringify({ status: sentQuote.status, hasToken: !!sentQuote.linkToken, expiresAt: sentQuote.expiresAt }))
    }

    if (sent.sent === false && sentQuote.lastSendStatus === 'NOT_SENT' && typeof sent.body === 'string' && sent.body.length > 0) {
      ok('SES is denied on dev, so SEND_QUOTE comes back with a copyable body', `sent=${sent.sent} lastSendStatus=${sentQuote.lastSendStatus} subject "${String(sent.subject).slice(0, 60)}"`)
    } else {
      bad('SEND_QUOTE reports what SES did', JSON.stringify({ sent: sent.sent, lastSendStatus: sentQuote.lastSendStatus, body: typeof sent.body }).slice(0, 200))
    }

    if (sent.link && String(sent.body).includes(sent.link)) {
      ok('the copyable body carries the link the customer answers on', `link ends …${tok8(sentQuote.linkToken)}`)
    } else {
      bad('the copyable body carries the link', `link=${sent.link ? 'present' : 'null'} — a body with no link cannot be answered (is PORTAL_ORIGIN set on dev?)`)
    }

    // The formatted shape is what an e-mail would leak, so both are looked for.
    const bodyLeaks = leaked({}, String(sent.body), {
      texts: [
        ['the internal note', INTERNAL_NOTE],
        ['the target buy', dollars(sentQuote.targetBuyCents)],
        ['the top spend', dollars(sentQuote.topSpendCents)],
        ['the margin', percent(sentQuote.marginBps)],
        ['the buy estimate', dollars(150000)],
        ['the carrier fixture name', carrierA.name],
      ],
      numbers: [
        ['targetBuyCents', sentQuote.targetBuyCents],
        ['topSpendCents', sentQuote.topSpendCents],
        ['marginBps', sentQuote.marginBps],
      ],
    })
    if (bodyLeaks.length === 0) {
      ok('the quote e-mail carries no target buy, no margin and no internal note', `${String(sent.body).length} characters, all of them customer-facing`)
    } else {
      bad('the quote e-mail leaks something internal', bodyLeaks.join(', '))
    }

    const lead = await getCustomer(customer.id)
    if (lead.status === 'QUOTED') ok("the customer's lead stage moved to QUOTED with the send", `${customer.status} → ${lead.status}`)
    else bad("the customer's lead stage moved to QUOTED", `status is ${lead.status}`)

    // ── the public sell link ────────────────────────────────────────────────
    const sellToken = sentQuote.linkToken
    const view = await publicGet(`/q/${sellToken}`)
    if (view.status === 200 && view.body?.quoteNumber === quoteId && view.body?.side === 'SELL' && view.body?.amountCents === 265000) {
      ok('GET /q/<token> shows the customer their own quote', `200 ${view.body.quoteNumber} ${view.body.amountCents} awaiting ${view.body.awaiting} · ${view.body.lines?.length ?? 0} line(s)`)
    } else {
      bad('GET /q/<token> shows the customer their own quote', `${view.status} ${view.text.slice(0, 180)}`)
    }

    const viewLeaks = leaked(view.body, view.text, {
      numbers: [
        ['targetBuyCents', sentQuote.targetBuyCents],
        ['topSpendCents', sentQuote.topSpendCents],
        ['marginBps', sentQuote.marginBps],
        ['the buy estimate', 150000],
      ],
      texts: [
        ['the internal note', INTERNAL_NOTE],
        ['the carrier name', carrierA.name],
        ['the target buy, formatted', dollars(sentQuote.targetBuyCents)],
        ['the margin, formatted', percent(sentQuote.marginBps)],
      ],
      keys: ['targetBuyCents', 'topSpendCents', 'marginBps', 'internalNotes', 'carrierName', 'carrierId', 'customerId'],
    })
    if (viewLeaks.length === 0) {
      ok('the public quote page carries none of the quote’s internal numbers', 'no target buy, top spend, margin, buy estimate, internal note or carrier')
    } else {
      bad('the public quote page leaks something internal', viewLeaks.join(', '))
    }

    const noName = await publicPost(`/q/${sellToken}/respond`, { action: 'ACCEPT', email: 'buyer@example.invalid' })
    if (noName.status === 400 && /Tell us your name so we know who answered/.test(noName.text)) {
      ok('a public answer with no name is refused', `400 ${noName.body?.error}`)
    } else bad('a public answer with no name is refused', `${noName.status} ${noName.text.slice(0, 160)}`)

    const badEmail = await publicPost(`/q/${sellToken}/respond`, { action: 'ACCEPT', name: 'Verification Buyer', email: 'not-an-address' })
    if (badEmail.status === 400 && /We need a working e-mail address so we can confirm your answer/.test(badEmail.text)) {
      ok('a public answer with no working e-mail is refused', `400 ${badEmail.body?.error}`)
    } else bad('a public answer with no working e-mail is refused', `${badEmail.status} ${badEmail.text.slice(0, 160)}`)

    const noReason = await publicPost(`/q/${sellToken}/respond`, { action: 'DECLINE', name: 'Verification Buyer', email: 'quote-buyer@example.invalid' })
    if (noReason.status === 400 && /Choose a reason so we know why this one did not work/.test(noReason.text)) {
      ok('a public DECLINE with no reason is refused', `400 ${noReason.body?.error}`)
    } else bad('a public DECLINE with no reason is refused', `${noReason.status} ${noReason.text.slice(0, 160)}`)

    const carrierVerb = await publicPost(`/q/${sellToken}/respond`, { action: 'QUOTE', name: 'Verification Buyer', email: 'quote-buyer@example.invalid', amountCents: 200000 })
    if (carrierVerb.status === 400 && /This quote can be accepted, countered or declined/.test(carrierVerb.text)) {
      ok('a carrier verb on a customer link is refused', `400 ${carrierVerb.body?.error}`)
    } else bad('a carrier verb on a customer link is refused', `${carrierVerb.status} ${carrierVerb.text.slice(0, 160)}`)

    const sameNumber = await publicPost(`/q/${sellToken}/respond`, { action: 'COUNTER', name: 'Verification Buyer', email: 'quote-buyer@example.invalid', amountCents: 265000 })
    if (sameNumber.status === 400 && /That is already the number on the table — accept it instead/.test(sameNumber.text)) {
      ok('a counter at the number already on the table is refused', `400 ${sameNumber.body?.error}`)
    } else bad('a counter at the number already on the table is refused', `${sameNumber.status} ${sameNumber.text.slice(0, 160)}`)

    const counterBody = {
      action: 'COUNTER',
      name: 'Verification Buyer',
      email: 'quote-buyer@example.invalid',
      amountCents: 240000,
      message: 'We can do 2400 all in.',
    }
    const countered = await publicPost(`/q/${sellToken}/respond`, counterBody)
    if (countered.status === 200 && countered.body?.status === 'RECEIVED_COUNTER' && countered.body?.response === 'COUNTERED') {
      ok('the customer counters once on the link', `200 ${countered.body.status}/${countered.body.response}`)
    } else bad('the customer counters once on the link', `${countered.status} ${countered.text.slice(0, 180)}`)

    /*
     * The same POST again, which must never land twice. Which refusal it gets is a
     * race the handler documents: `quoteRespondRoute` reads the sparse token index
     * first, so a stale read still finds the row and loses on the base table's
     * condition with 410 ("already been answered"), while a caught-up read cannot
     * find it at all and answers 404 ("no longer active"). Both are one-use-per-
     * round; anything else — a 200, or a row that moved again — is the bug.
     */
    const replay = await publicPost(`/q/${sellToken}/respond`, counterBody)
    const replayGone = (replay.status === 410 && /This quote has already been answered/.test(replay.text))
      || (replay.status === 404 && /This quote link is no longer active/.test(replay.text))
    const afterReplay = await getQuote(quoteId)
    if (replayGone && afterReplay.rounds === 1) {
      ok('the same POST again is refused — one use per round', `${replay.status} ${replay.body?.error} · still round ${afterReplay.rounds}`)
    } else {
      bad('the same POST again is refused', `${replay.status} ${replay.text.slice(0, 160)} · rounds ${afterReplay.rounds}`)
    }

    const spentView = await publicGet(`/q/${sellToken}`)
    if (spentView.status === 404 && /This quote link is no longer active/.test(spentView.text)) {
      ok('GET on a spent link is 404', `404 ${spentView.body?.error}`)
    } else bad('GET on a spent link is 404', `${spentView.status} ${spentView.text.slice(0, 160)}`)

    const afterCounter = await getQuote(quoteId)
    if (afterCounter.status === 'RECEIVED_COUNTER' && afterCounter.counterCents === 240000 && afterCounter.counterBy === 'THEM'
      && afterCounter.rounds === 1 && !afterCounter.linkToken && afterCounter.responderEmail === 'quote-buyer@example.invalid') {
      ok('the row records their counter, who sent it, and drops the token', `${afterCounter.status} ${afterCounter.counterCents} by ${afterCounter.counterBy} round ${afterCounter.rounds} from ${afterCounter.responderName}`)
    } else {
      bad('the row records their counter', JSON.stringify({ status: afterCounter.status, counterCents: afterCounter.counterCents, counterBy: afterCounter.counterBy, rounds: afterCounter.rounds, token: !!afterCounter.linkToken }))
    }

    // ── COUNTER_QUOTE ───────────────────────────────────────────────────────
    const ourCounter = await shipAction('COUNTER_QUOTE', {
      quoteId,
      amountCents: 252000,
      via: 'EMAIL',
      message: 'We can meet you at 2520.',
      to: ['quote-buyer@example.invalid'],
    })
    const counterQuote = await getQuote(quoteId)
    if (counterQuote.status === 'SENT_COUNTER' && counterQuote.linkToken && counterQuote.linkToken !== sellToken
      && counterQuote.linkVersion === 2 && counterQuote.rounds === 2 && ourCounter.sent === false) {
      ok('COUNTER_QUOTE mints a new link for the next round', `${counterQuote.status} link:${tok8(sellToken)} → ${tok8(counterQuote.linkToken)} round ${counterQuote.rounds} sent=${ourCounter.sent}`)
    } else {
      bad('COUNTER_QUOTE mints a new link', JSON.stringify({ status: counterQuote.status, newToken: counterQuote.linkToken !== sellToken, linkVersion: counterQuote.linkVersion, rounds: counterQuote.rounds, sent: ourCounter.sent }))
    }

    if (counterQuote.amountCents === 252000 && counterQuote.counterBy === 'US') {
      ok('our counter is absorbed into the line haul and stays Σ of the CUSTOMER lines', `amount ${counterQuote.amountCents} counterBy ${counterQuote.counterBy}`)
    } else {
      bad('our counter is absorbed into the line haul', JSON.stringify({ amountCents: counterQuote.amountCents, counterBy: counterQuote.counterBy, counterCents: counterQuote.counterCents }))
    }

    const accepted = await publicPost(`/q/${counterQuote.linkToken}/respond`, {
      action: 'ACCEPT', name: 'Verification Buyer', email: 'quote-buyer@example.invalid', message: 'Booked, thanks.',
    })
    if (accepted.status === 200 && accepted.body?.status === 'RECEIVED_REPLY') {
      ok('the customer accepts on the new link', `200 ${accepted.body.status}/${accepted.body.response}`)
    } else bad('the customer accepts on the new link', `${accepted.status} ${accepted.text.slice(0, 180)}`)

    const replied = await getQuote(quoteId)
    if (replied.status === 'RECEIVED_REPLY' && replied.response === 'ACCEPTED' && replied.acceptedVia === 'LINK' && !replied.linkToken) {
      ok('the quote reaches RECEIVED_REPLY with the link spent', `${replied.status} via ${replied.acceptedVia} at ${replied.respondedAt}`)
    } else {
      bad('the quote reaches RECEIVED_REPLY', JSON.stringify({ status: replied.status, response: replied.response, acceptedVia: replied.acceptedVia, token: !!replied.linkToken }))
    }

    // ── CONVERT_QUOTE ───────────────────────────────────────────────────────
    // The lead has to become an account before freight can be built for it: that is
    // `getActiveCustomer`, and it is the same gate SUBMIT_ORDER has always had.
    const beforePromote = await getCustomer(customer.id)
    const promoted = await dirAction('SET_CUSTOMER_STATUS', {
      id: customer.id,
      expectedUpdatedAt: beforePromote.updatedAt,
      status: 'ACTIVE',
    }).then((r) => r.customer ?? r).catch((err) => ({ error: String(err.message ?? err) }))
    if (promoted.status === 'ACTIVE') ok('the lead is promoted to an account before conversion', `${beforePromote.status} → ${promoted.status}`)
    else bad('the lead is promoted to an account before conversion', JSON.stringify(promoted).slice(0, 180))

    const converted = await shipAction('CONVERT_QUOTE', { quoteId, acceptedVia: 'LINK' })
    const firstShipmentId = String(converted.bundle.shipment.id)
    noteShipment(converted.bundle, 'converted from the quote, then reverted')
    const firstOrder = converted.bundle.orders[0]
    const firstLoad = converted.bundle.loads[0]
    if (converted.quote.status === 'WON' && firstShipmentId && firstOrder?.id && firstLoad?.id && converted.quote.wonAt) {
      ok('CONVERT_QUOTE builds the shipment, the order and the load, and wins the quote', `${converted.quote.status} ${converted.bundle.shipment.number} order ${firstOrder.id} load ${firstLoad.loadNumber ?? firstLoad.id} (${firstLoad.status})`)
    } else {
      bad('CONVERT_QUOTE builds freight', JSON.stringify({ status: converted.quote.status, shipment: firstShipmentId, order: firstOrder?.id, load: firstLoad?.id }).slice(0, 220))
    }

    if (firstOrder?.quoteId === quoteId && firstOrder?.quoteNumber === quoteId && firstOrder?.quoteAmountCents === 252000) {
      ok('the order carries the quote it came from', `quoteId ${firstOrder.quoteId} quoteNumber ${firstOrder.quoteNumber} quoteAmountCents ${firstOrder.quoteAmountCents}`)
    } else {
      bad('the order carries the quote it came from', JSON.stringify({ quoteId: firstOrder?.quoteId, quoteNumber: firstOrder?.quoteNumber, quoteAmountCents: firstOrder?.quoteAmountCents }))
    }

    if (firstOrder?.revenueCents === replied.amountCents && firstOrder?.revenueCents === 252000) {
      ok("the order's revenue is exactly the quote's number", `revenue ${firstOrder.revenueCents} = quote ${replied.amountCents}`)
    } else {
      bad("the order's revenue is the quote's number", `revenue ${firstOrder?.revenueCents} vs quote ${replied.amountCents}`)
    }

    await refuses('a second CONVERT_QUOTE on the same quote is refused', /A WON quote cannot be converted/i, () =>
      shipAction('CONVERT_QUOTE', { quoteId }))

    await refuses('SEND_QUOTE on a WON quote is refused', /A WON quote cannot be sent — restore it or duplicate it first/i, () =>
      shipAction('SEND_QUOTE', { quoteId, via: 'COPY' }))

    await refuses('REVERT_TO_QUOTE will not move freight without a reason', /reason must be a string/i, () =>
      shipAction('REVERT_TO_QUOTE', { quoteId }))

    // ── REVERT_TO_QUOTE, and converting again ───────────────────────────────
    const reverted = await shipAction('REVERT_TO_QUOTE', { quoteId, reason: 'dev verification: putting it back' })
    if (reverted.quote.status === 'RECEIVED_REPLY' && !reverted.quote.shipmentId && !reverted.quote.orderId) {
      ok('REVERT_TO_QUOTE puts the quote back to RECEIVED_REPLY', `${reverted.quote.status}, shipment and order unlinked`)
    } else {
      bad('REVERT_TO_QUOTE puts the quote back', JSON.stringify({ status: reverted.quote.status, shipmentId: reverted.quote.shipmentId, orderId: reverted.quote.orderId }))
    }

    const revertedBundle = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: firstShipmentId })
    if (revertedBundle.shipment.deletedAt) {
      ok('the shipment the quote built is soft-deleted by the revert', `${revertedBundle.shipment.number} deletedAt ${revertedBundle.shipment.deletedAt}`)
    } else {
      bad('the shipment the quote built is soft-deleted', `${revertedBundle.shipment.number} is still live`)
    }

    const reconverted = await shipAction('CONVERT_QUOTE', { quoteId, acceptedVia: 'LINK' })
    const liveShipmentId = String(reconverted.bundle.shipment.id)
    noteShipment(reconverted.bundle, 'the live conversion')
    const liveQuoteRow = await getQuote(quoteId)
    if (reconverted.quote.status === 'WON' && liveShipmentId !== firstShipmentId
      && !reconverted.bundle.shipment.deletedAt && liveQuoteRow.shipmentId === liveShipmentId) {
      ok('converting again works and leaves exactly one live shipment', `${revertedBundle.shipment.number} deleted · ${reconverted.bundle.shipment.number} live and on the quote`)
    } else {
      bad('converting again leaves one live shipment', JSON.stringify({ status: reconverted.quote.status, live: liveShipmentId, first: firstShipmentId, onQuote: liveQuoteRow.shipmentId }).slice(0, 220))
    }

    // ── the credit gate ─────────────────────────────────────────────────────
    const heldSave = await shipAction('SAVE_QUOTE', {
      customerId: heldCustomer.id,
      mode: 'FTL',
      equipmentType: 'Dry Van',
      miles: 925,
      weightLbs: 40000,
      contactName: 'Held Buyer',
      contactEmail: 'quote-held@example.invalid',
      stops: stopsFor('Credit'),
      lines: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 180000, count: 1 }],
    })
    const heldQuoteId = noteQuote(String(heldSave.quote.id), 'credit-hold quote, left QUOTED')
    await shipAction('SEND_QUOTE', { quoteId: heldQuoteId, via: 'COPY' })
    const heldBefore = await getQuote(heldQuoteId)

    await refuses('CONVERT_QUOTE is blocked for a customer on credit hold', /is on credit hold/i, () =>
      shipAction('CONVERT_QUOTE', { quoteId: heldQuoteId }))

    const heldAfter = await getQuote(heldQuoteId)
    if (heldAfter.status === heldBefore.status && heldAfter.version === heldBefore.version
      && heldAfter.linkToken === heldBefore.linkToken && !heldAfter.shipmentId) {
      ok('the blocked quote is left exactly where it was', `${heldAfter.status} version ${heldAfter.version}, link:${tok8(heldAfter.linkToken)} still live, no shipment`)
    } else {
      bad('the blocked quote is left where it was', JSON.stringify({ status: heldAfter.status, version: heldAfter.version, shipmentId: heldAfter.shipmentId }))
    }

    await refuses('COUNTER_QUOTE on a quote nobody has answered is refused', /A QUOTED quote has nothing to counter/i, () =>
      shipAction('COUNTER_QUOTE', { quoteId: heldQuoteId, amountCents: 170000, via: 'COPY' }))

    // ── the other sell rungs ────────────────────────────────────────────────
    const duplicated = await shipAction('DUPLICATE_QUOTE', {
      quoteId,
      count: 4,
      pickupAppts: [`${day(8)}T13:00:00.000Z`, `${day(15)}T13:00:00.000Z`],
    })
    const copies = duplicated.quotes ?? []
    for (const copy of copies) noteQuote(String(copy.id), 'duplicate')
    const copyIds = new Set(copies.map((c) => String(c.id)))
    const allDrafts = copies.every((c) => c.status === 'DRAFT' && !c.linkToken && String(c.duplicatedFromId) === quoteId)
    if (copies.length === 4 && copyIds.size === 4 && !copyIds.has(quoteId) && allDrafts) {
      ok('DUPLICATE_QUOTE makes N drafts, each with its own number and no token', copies.map((c) => c.id).join(', '))
    } else {
      bad('DUPLICATE_QUOTE makes N drafts', JSON.stringify(copies.map((c) => ({ id: c.id, status: c.status, token: !!c.linkToken }))).slice(0, 240))
    }

    const exposure = duplicated.exposure ?? {}
    if (typeof exposure.projectedCents === 'number' && exposure.projectedCents > 0 && exposure.creditLimitCents === 500000000) {
      ok('DUPLICATE_QUOTE reports what the customer would owe if every open quote landed', `projected ${exposure.projectedCents} against ${exposure.creditLimitCents} overLimit=${exposure.overLimit}`)
    } else {
      bad('DUPLICATE_QUOTE reports the projected exposure', JSON.stringify(exposure).slice(0, 200))
    }

    const [lostCopy, canceledCopy, passedCopy, counterCopy] = copies.map((c) => String(c.id))

    // A quote that went out, was lost, and came back: the link must not come back.
    await shipAction('SEND_QUOTE', { quoteId: lostCopy, via: 'EMAIL', to: ['quote-buyer@example.invalid'] })
    const lostSent = await getQuote(lostCopy)
    await shipAction('MARK_QUOTE_LOST', { quoteId: lostCopy, reason: 'TOO_HIGH', note: 'dev verification' })
    const lostRow = await getQuote(lostCopy)
    if (lostRow.status === 'LOST' && lostRow.lostReason === 'TOO_HIGH' && !lostRow.linkToken && !lostRow.quoteOpen) {
      ok('MARK_QUOTE_LOST closes the quote and kills the link it had', `${lostRow.status}/${lostRow.lostReason}, link:${tok8(lostSent.linkToken)} gone, off the open board`)
    } else {
      bad('MARK_QUOTE_LOST closes the quote', JSON.stringify({ status: lostRow.status, lostReason: lostRow.lostReason, token: !!lostRow.linkToken, quoteOpen: lostRow.quoteOpen }))
    }

    await shipAction('RESTORE_QUOTE', { quoteId: lostCopy })
    const restored = await getQuote(lostCopy)
    if (restored.status === 'QUOTED' && !restored.linkToken && restored.quoteOpen === 'OPEN'
      && restored.expiresAt === '9999-12-31T23:59:59.999Z' && !restored.lostReason) {
      ok('RESTORE_QUOTE returns it to QUOTED with no link token', `${restored.status}, no token, expiresAt ${restored.expiresAt}`)
    } else {
      bad('RESTORE_QUOTE returns it to QUOTED with no token', JSON.stringify({ status: restored.status, token: !!restored.linkToken, expiresAt: restored.expiresAt, lostReason: restored.lostReason }))
    }

    await shipAction('CANCEL_QUOTE', { quoteId: canceledCopy, note: 'dev verification' })
    const canceledRow = await getQuote(canceledCopy)
    if (canceledRow.status === 'CANCELED' && !canceledRow.quoteOpen) {
      ok('CANCEL_QUOTE takes a draft off the board', `${canceledRow.status} at ${canceledRow.closedAt}`)
    } else bad('CANCEL_QUOTE takes a draft off the board', JSON.stringify({ status: canceledRow.status, quoteOpen: canceledRow.quoteOpen }))

    await shipAction('PASS_QUOTE', { quoteId: passedCopy, note: 'dev verification' })
    const passedRow = await getQuote(passedCopy)
    if (passedRow.status === 'PASS' && passedRow.lostReason === 'WITHDRAWN') {
      ok('PASS_QUOTE passes on a customer quote', `${passedRow.status}/${passedRow.lostReason}`)
    } else bad('PASS_QUOTE passes on a customer quote', JSON.stringify({ status: passedRow.status, lostReason: passedRow.lostReason }))

    await refuses('REJECT_OFFER refuses a customer quote', /Use MARK_QUOTE_LOST on a customer quote/i, () =>
      shipAction('REJECT_OFFER', { quoteId: passedCopy }))

    await refuses('a quote that has gone out can no longer be edited', /A QUOTED quote can no longer be edited — counter it or send it again/i, () =>
      shipAction('SAVE_QUOTE', { quoteId: restored.id, internalNotes: 'too late' }))

    // ACCEPT_COUNTER: their number, taken by us rather than on the link.
    await shipAction('SEND_QUOTE', { quoteId: counterCopy, via: 'EMAIL', to: ['quote-buyer@example.invalid'] })
    const counterCopyRow = await getQuote(counterCopy)
    const theirCounter = await publicPost(`/q/${counterCopyRow.linkToken}/respond`, {
      action: 'COUNTER', name: 'Verification Buyer', email: 'quote-buyer@example.invalid', amountCents: 230000,
    })
    if (theirCounter.status !== 200) bad('the spare quote takes a counter on its link', `${theirCounter.status} ${theirCounter.text.slice(0, 160)}`)
    else ok('the spare quote takes a counter on its link', `200 ${theirCounter.body?.status}`)

    await refuses('CONVERT_QUOTE from RECEIVED_COUNTER is refused', /A RECEIVED_COUNTER quote cannot be converted/i, () =>
      shipAction('CONVERT_QUOTE', { quoteId: counterCopy }))

    const takenCounter = await shipAction('ACCEPT_COUNTER', { quoteId: counterCopy })
    if (takenCounter.quote.status === 'RECEIVED_REPLY' && takenCounter.quote.amountCents === 230000
      && takenCounter.quote.response === 'ACCEPTED' && !takenCounter.quote.linkToken) {
      ok('ACCEPT_COUNTER takes their number and the lines still add up to it', `${takenCounter.quote.status} amount ${takenCounter.quote.amountCents} via ${takenCounter.quote.acceptedVia}`)
    } else {
      bad('ACCEPT_COUNTER takes their number', JSON.stringify({ status: takenCounter.quote.status, amountCents: takenCounter.quote.amountCents, token: !!takenCounter.quote.linkToken }))
    }

    // The ‡ gate: a thin quote carries its warnings and cannot be sent past them.
    const thin = await shipAction('SAVE_QUOTE', {
      customerId: customer.id,
      mode: 'FTL',
      equipmentType: 'Dry Van',
      miles: 925,
      contactName: 'Verification Buyer',
      contactEmail: 'quote-buyer@example.invalid',
      stops: stopsFor('Thin'),
      lines: [
        { side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 100000, count: 1 },
        { side: 'CARRIER', code: 'LINEHAUL', rateCents: 99000, count: 1 },
      ],
    })
    const thinId = noteQuote(String(thin.quote.id), 'thin-margin quote')
    const thinWarnings = thin.quote.pricingWarnings ?? (thin.pricing?.warnings ?? []).map((w) => w.key)
    if (thinWarnings.includes('BELOW_MIN_PROFIT')) {
      ok('a quote under the customer’s minimum carries the warning on the row', thinWarnings.join(', '))
    } else {
      bad('a quote under the customer’s minimum carries the warning', JSON.stringify(thinWarnings))
    }

    await refuses('SEND_QUOTE refuses an unacknowledged ‡ warning', /Acknowledge these before sending:/i, () =>
      shipAction('SEND_QUOTE', { quoteId: thinId, via: 'COPY' }))

    if (isAdmin) {
      const thinSent = await shipAction('SEND_QUOTE', {
        quoteId: thinId,
        via: 'COPY',
        acknowledgeWarnings: ['BELOW_MIN_PROFIT', 'BELOW_MARGIN_FLOOR'],
      }).catch((err) => ({ error: String(err.message ?? err) }))
      if (thinSent.error) bad('an admin may send past an acknowledged ‡ warning', thinSent.error.slice(0, 180))
      else ok('an admin may send past an acknowledged ‡ warning', `${thinSent.quote.status} warnings ${JSON.stringify(thinSent.quote.pricingWarnings)}`)
    } else {
      await refuses('only an admin may send past a ‡ warning', /Only an admin can send this quote:/i, () =>
        shipAction('SEND_QUOTE', { quoteId: thinId, via: 'COPY', acknowledgeWarnings: ['BELOW_MIN_PROFIT', 'BELOW_MARGIN_FLOOR'] }))
    }

    // SAVE_QUOTE_SETTINGS is admin-only and every one of these refuses before it
    // writes, so the org's real settings are never touched by this script.
    if (isAdmin) {
      await refuses('SAVE_QUOTE_SETTINGS refuses a template with no {link}', /The quote e-mail template needs a \{link\} token/i, () =>
        shipAction('SAVE_QUOTE_SETTINGS', { quoteEmailTemplate: 'Here is our quote. Call us.' }))
      await refuses('SAVE_QUOTE_SETTINGS refuses a number format with no {n}', /The quote number format needs an \{n\} token/i, () =>
        shipAction('SAVE_QUOTE_SETTINGS', { quoteNumberFormat: 'QUOTE' }))
      await refuses('SAVE_QUOTE_SETTINGS refuses a quote counter that goes backwards', /The quote counter is at \d+ and can only go forward/i, () =>
        shipAction('SAVE_QUOTE_SETTINGS', { nextQuoteNumber: 0 }))
    } else {
      for (const field of ['quoteEmailTemplate', 'quoteNumberFormat', 'nextQuoteNumber']) {
        await refuses(`SAVE_QUOTE_SETTINGS is refused to a non-admin (${field})`, /Forbidden: SAVE_QUOTE_SETTINGS requires owner or ADMIN/i, () =>
          shipAction('SAVE_QUOTE_SETTINGS', { [field]: field === 'nextQuoteNumber' ? 1 : 'x' }))
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // BUY SIDE
    // ════════════════════════════════════════════════════════════════════════

    const buyBundle = await makeShipment('carrier offers', 300000)
    const buyShipmentId = String(buyBundle.shipment.id)
    const buyLoad = buyBundle.loads[0]

    const requested = await shipAction('REQUEST_OFFERS', {
      loadId: buyLoad.id,
      carrierIds: [carrierA.id, carrierB.id],
      via: 'EMAIL',
      message: 'Dev verification offer request.',
    })
    const offers = requested.offers ?? []
    for (const offer of offers) noteQuote(String(offer.id), 'carrier offer')
    const offerA = offers.find((o) => o.carrierId === carrierA.id)
    const offerB = offers.find((o) => o.carrierId === carrierB.id)
    const groupIds = new Set(offers.map((o) => o.groupId))
    const tokens = new Set(offers.map((o) => o.linkToken))
    if (offers.length === 2 && groupIds.size === 1 && tokens.size === 2 && offerA && offerB
      && offers.every((o) => o.status === 'REQUESTED' && o.side === 'BUY' && o.linkToken && o.expiresAt)) {
      ok('REQUEST_OFFERS opens one REQUESTED row per carrier under one group, each with its own link', `group ${requested.groupId} · ${offerA.id} link:${tok8(offerA.linkToken)} · ${offerB.id} link:${tok8(offerB.linkToken)} · expires ${offerA.expiresAt}`)
    } else {
      bad('REQUEST_OFFERS opens one row per carrier under one group', JSON.stringify(offers.map((o) => ({ id: o.id, status: o.status, group: o.groupId, token: !!o.linkToken }))).slice(0, 240))
    }

    const notices = await indexQuery(
      'listShipmentNoticeByShipmentIdAndAt',
      '$shipmentId: String!',
      'shipmentId: $shipmentId',
      { shipmentId: buyShipmentId },
      'id shipmentId loadId kind channel status error subject to at createdBy',
    )
    const offerNotice = notices.find((n) => n.kind === 'CARRIER_OFFER' && n.id === `cof:${offerA.id}`)
    if (offerNotice && offerNotice.status === 'NOT_SENT') {
      ok('the offer request is recorded as a CARRIER_OFFER notice, NOT_SENT on dev', `${offerNotice.id} ${offerNotice.kind}/${offerNotice.status} to ${offerNotice.to}`)
    } else {
      bad('the offer request is recorded as a CARRIER_OFFER notice', JSON.stringify(notices.map((n) => ({ id: n.id, kind: n.kind, status: n.status }))).slice(0, 220))
    }

    const carrierView = await publicGet(`/q/${offerA.linkToken}`)
    const carrierText = carrierView.text
    if (carrierView.status === 200 && carrierView.body?.side === 'BUY' && carrierView.body?.quoteNumber === offerA.id
      && /Chicago/.test(carrierText) && /Dallas/.test(carrierText)) {
      ok('GET /q/<token> shows the carrier the lane and our number', `200 ${carrierView.body.quoteNumber} ${carrierView.body.stops?.length ?? 0} stop(s) equipment ${carrierView.body.equipmentType}`)
    } else {
      bad('GET /q/<token> shows the carrier the lane and our number', `${carrierView.status} ${carrierText.slice(0, 180)}`)
    }

    const carrierLeaks = leaked(carrierView.body, carrierText, {
      numbers: [["the customer's rate", 300000], ['the sell quote', 252000]],
      texts: [['the customer name', customer.name], ['the customer contact', 'quote-buyer@example.invalid']],
      keys: ['customerName', 'customerId', 'customerRateCents', 'targetBuyCents', 'marginBps', 'internalNotes'],
    })
    if (carrierLeaks.length === 0) {
      ok("the carrier's page carries neither the customer's name nor the customer's rate", 'lane, equipment and our number only')
    } else {
      bad("the carrier's page leaks the customer", carrierLeaks.join(', '))
    }

    const noAmount = await publicPost(`/q/${offerA.linkToken}/respond`, {
      action: 'QUOTE', name: 'Verification Dispatch', email: 'quote-carrier-a@example.invalid',
    })
    if (noAmount.status === 400 && /Enter the rate you will haul this load for/.test(noAmount.text)) {
      ok('a carrier QUOTE with no amount is refused', `400 ${noAmount.body?.error}`)
    } else bad('a carrier QUOTE with no amount is refused', `${noAmount.status} ${noAmount.text.slice(0, 160)}`)

    const carrierQuoted = await publicPost(`/q/${offerA.linkToken}/respond`, {
      action: 'QUOTE', name: 'Verification Dispatch', email: 'quote-carrier-a@example.invalid', amountCents: 170000,
    })
    const quotedOffer = await getQuote(offerA.id)
    if (carrierQuoted.status === 200 && quotedOffer.status === 'QUOTED' && quotedOffer.amountCents === 170000 && !quotedOffer.linkToken) {
      ok('the carrier names a price on the link and the offer goes QUOTED', `200 ${quotedOffer.status} amount ${quotedOffer.amountCents} round ${quotedOffer.rounds}`)
    } else {
      bad('the carrier names a price on the link', `${carrierQuoted.status} ${carrierQuoted.text.slice(0, 120)} · row ${quotedOffer.status}/${quotedOffer.amountCents}`)
    }

    const ourOffer = await shipAction('COUNTER_OFFER', {
      quoteId: offerA.id,
      amountCents: 160000,
      via: 'EMAIL',
      message: 'We can do 1600 on this one.',
    })
    const counteredOffer = await getQuote(offerA.id)
    if (counteredOffer.status === 'SENT_COUNTER' && counteredOffer.linkToken && counteredOffer.linkToken !== offerA.linkToken
      && counteredOffer.linkVersion === 2 && ourOffer.sent === false) {
      ok('COUNTER_OFFER answers the carrier with a new link', `${counteredOffer.status} link:${tok8(offerA.linkToken)} → ${tok8(counteredOffer.linkToken)} round ${counteredOffer.rounds}`)
    } else {
      bad('COUNTER_OFFER answers the carrier with a new link', JSON.stringify({ status: counteredOffer.status, newToken: counteredOffer.linkToken !== offerA.linkToken, linkVersion: counteredOffer.linkVersion, sent: ourOffer.sent }))
    }

    /*
     * The BUY money convention, read off the row exactly as the booking reads it:
     * `amountCents` is the carrier's number and `counterCents`/`counterBy` is the
     * last counter, so the rate a load books at is their counter when they made one
     * and the row's number otherwise.
     */
    const agreedRateOf = (row) => (row.counterBy === 'THEM' && row.counterCents ? row.counterCents : row.amountCents)

    const carrierAccepted = await publicPost(`/q/${counteredOffer.linkToken}/respond`, {
      action: 'ACCEPT',
      name: 'Verification Dispatch',
      email: 'quote-carrier-a@example.invalid',
      amountCents: 160000,
    })
    const acceptedOffer = await getQuote(offerA.id)
    if (carrierAccepted.status === 200 && acceptedOffer.status === 'RECEIVED_REPLY'
      && acceptedOffer.acceptedVia === 'LINK' && agreedRateOf(acceptedOffer) === 160000) {
      ok('the carrier accepts our counter on the link', `200 ${acceptedOffer.status} agreed ${agreedRateOf(acceptedOffer)} (amount ${acceptedOffer.amountCents}, counter ${acceptedOffer.counterCents} by ${acceptedOffer.counterBy})`)
    } else {
      bad('the carrier accepts our counter on the link', `${carrierAccepted.status} ${carrierAccepted.text.slice(0, 140)} · row ${acceptedOffer.status} agreed ${agreedRateOf(acceptedOffer)}`)
    }

    const stillSourcing = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: buyShipmentId })
    const sourcingLoad = stillSourcing.loads[0]
    if (sourcingLoad.status === 'SOURCING' && legsOf(stillSourcing).filter((l) => l.status === 'ACTIVE').length === 0) {
      ok("a carrier's accept never books the load", `load ${sourcingLoad.status}, no assignment on it`)
    } else {
      bad("a carrier's accept never books the load", `load ${sourcingLoad.status}, ${legsOf(stillSourcing).length} assignment(s)`)
    }

    const booked = await shipAction('ACCEPT_OFFER', {
      quoteId: offerA.id,
      expectedUpdatedAt: sourcingLoad.updatedAt,
      acknowledgeWarnings: BOOKING_ACKS,
    })
    const bookedBundle = booked.bundle ?? await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: buyShipmentId })
    const leg = legsOf(bookedBundle).find((l) => l.kind === 'CARRIER' && l.status === 'ACTIVE')
    const wonOffer = await getQuote(offerA.id)
    if (leg && leg.quoteId === offerA.id && leg.carrierRateCents === 160000 && wonOffer.status === 'WON') {
      ok('ACCEPT_OFFER books the truck at the rate the carrier agreed to', `${leg.id} carrier ${leg.carrierName} rate ${leg.carrierRateCents} quoteId ${leg.quoteId} · offer ${wonOffer.status}`)
    } else {
      bad('ACCEPT_OFFER books the truck at the agreed rate', JSON.stringify({ leg: leg?.id, quoteId: leg?.quoteId, rate: leg?.carrierRateCents, offer: wonOffer.status }).slice(0, 220))
    }

    const closedSibling = await getQuote(offerB.id)
    if ((closedSibling.status === 'CANCELED' || closedSibling.status === 'LOST') && !closedSibling.quoteOpen && !closedSibling.linkToken) {
      ok('the sibling offers are closed by the booking', `${offerB.id} ${closedSibling.status}${closedSibling.lostReason ? `/${closedSibling.lostReason}` : ''}, link gone`)
    } else {
      bad('the sibling offers are closed by the booking', JSON.stringify({ status: closedSibling.status, quoteOpen: closedSibling.quoteOpen, token: !!closedSibling.linkToken }))
    }

    await refuses('REQUEST_OFFERS refuses a load that is already covered', /That load already has an active assignment/i, () =>
      shipAction('REQUEST_OFFERS', { loadId: buyLoad.id, carrierIds: [carrierB.id], via: 'COPY' }))

    await refuses('ACCEPT_OFFER refuses an offer that is already closed', /offer cannot be booked/i, () =>
      shipAction('ACCEPT_OFFER', { quoteId: offerB.id, expectedUpdatedAt: sourcingLoad.updatedAt }))

    await refuses('ACCEPT_OFFER refuses a customer quote', /Use CONVERT_QUOTE on a customer quote/i, () =>
      shipAction('ACCEPT_OFFER', { quoteId: canceledCopy }))

    // ── expiry, the sweep, and what a plain booking does to open offers ─────
    const sweepBundle = await makeShipment('expiry and open offers', 280000)
    const sweepShipmentId = String(sweepBundle.shipment.id)
    const sweepLoad = sweepBundle.loads[0]

    await refuses('LOG_OFFER needs the number the carrier gave us', /amountCents is required/i, () =>
      shipAction('LOG_OFFER', { loadId: sweepLoad.id, carrierId: carrierB.id }))

    const phoned = await shipAction('LOG_OFFER', {
      loadId: sweepLoad.id,
      carrierId: carrierB.id,
      amountCents: 165000,
      contactName: 'Verification Dispatch',
      note: 'dev verification: phoned in',
    })
    const phonedId = noteQuote(String(phoned.quote.id), 'phoned-in offer, rejected')
    if (phoned.quote.status === 'QUOTED' && !phoned.quote.linkToken && phoned.quote.acceptedVia === 'PHONE'
      && phoned.quote.expiresAt === '9999-12-31T23:59:59.999Z') {
      ok('LOG_OFFER lands a phoned-in price QUOTED with no link and no clock', `${phonedId} ${phoned.quote.status} ${phoned.quote.amountCents} via ${phoned.quote.acceptedVia}`)
    } else {
      bad('LOG_OFFER lands a phoned-in price', JSON.stringify({ status: phoned.quote.status, token: !!phoned.quote.linkToken, expiresAt: phoned.quote.expiresAt }))
    }

    await shipAction('REJECT_OFFER', { quoteId: phonedId, reason: 'TOO_HIGH', note: 'dev verification' })
    const rejected = await getQuote(phonedId)
    if (rejected.status === 'LOST' && rejected.lostReason === 'TOO_HIGH' && !rejected.quoteOpen) {
      ok('REJECT_OFFER closes an offer with the reason the next person reads', `${rejected.status}/${rejected.lostReason}`)
    } else {
      bad('REJECT_OFFER closes an offer', JSON.stringify({ status: rejected.status, lostReason: rejected.lostReason }))
    }

    // An offer minted with a clock that has already struck: the public link is the
    // thing that finds it, and reading it is what kills it.
    const deadRequest = await shipAction('REQUEST_OFFERS', {
      loadId: sweepLoad.id,
      carrierIds: [carrierB.id],
      via: 'COPY',
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    })
    const deadOffer = deadRequest.offers[0]
    noteQuote(String(deadOffer.id), 'expired offer')
    const deadView = await publicGet(`/q/${deadOffer.linkToken}`)
    if (deadView.status === 404 && /This quote link is no longer active/.test(deadView.text)) {
      ok('a link whose hour has passed answers 404', `404 ${deadView.body?.error}`)
    } else bad('a link whose hour has passed answers 404', `${deadView.status} ${deadView.text.slice(0, 160)}`)

    const deadRow = await getQuote(deadOffer.id)
    if (deadRow.status === 'LOST' && deadRow.lostReason === 'EXPIRED' && !deadRow.linkToken && !deadRow.quoteOpen) {
      ok('reading an expired link writes it LOST/EXPIRED and takes the token off', `${deadRow.status}/${deadRow.lostReason} by ${deadRow.updatedBy}`)
    } else {
      bad('reading an expired link writes it LOST/EXPIRED', JSON.stringify({ status: deadRow.status, lostReason: deadRow.lostReason, token: !!deadRow.linkToken }))
    }

    const malformed = await publicGet('/q/not-a-real-token')
    if (malformed.status === 404 && /This quote link is no longer active/.test(malformed.text)) {
      ok('a malformed token is 404, and says nothing about why', `404 ${malformed.body?.error}`)
    } else bad('a malformed token is 404', `${malformed.status} ${malformed.text.slice(0, 160)}`)

    // The sweep's own row: QUOTED, on a clock, left to strike.
    const SWEEP_SECONDS = 20
    const sweepRequest = await shipAction('REQUEST_OFFERS', {
      loadId: sweepLoad.id,
      carrierIds: [carrierB.id],
      via: 'COPY',
      expiresAt: new Date(Date.now() + SWEEP_SECONDS * 1000).toISOString(),
    })
    const sweepOffer = sweepRequest.offers[0]
    noteQuote(String(sweepOffer.id), 'swept offer')
    const sweepQuoted = await publicPost(`/q/${sweepOffer.linkToken}/respond`, {
      action: 'QUOTE', name: 'Verification Dispatch', email: 'quote-carrier-b@example.invalid', amountCents: 158000,
    })
    if (sweepQuoted.status !== 200) {
      bad('the sweep fixture is priced before its clock strikes', `${sweepQuoted.status} ${sweepQuoted.text.slice(0, 160)}`)
    } else {
      ok('the sweep fixture is priced before its clock strikes', `200 ${sweepQuoted.body?.status} expires ${sweepOffer.expiresAt}`)
    }
    const waitMs = Date.parse(sweepOffer.expiresAt) - Date.now() + 2000
    if (waitMs > 0) {
      console.log(`  (waiting ${Math.ceil(waitMs / 1000)}s for the offer clock to strike)`)
      await sleep(waitMs)
    }

    const firstSweep = await shipAction('SWEEP_EXPIRED_QUOTES', {})
    const sweptRow = await getQuote(sweepOffer.id)
    if (sweptRow.status === 'LOST' && sweptRow.lostReason === 'EXPIRED' && !sweptRow.quoteOpen && !sweptRow.linkToken) {
      ok('SWEEP_EXPIRED_QUOTES closes a quote whose hour has passed', `${firstSweep.expired} expired · ${sweepOffer.id} ${sweptRow.status}/${sweptRow.lostReason} version ${sweptRow.version}`)
    } else {
      bad('SWEEP_EXPIRED_QUOTES closes an expired quote', JSON.stringify({ expired: firstSweep.expired, status: sweptRow.status, lostReason: sweptRow.lostReason }))
    }

    const secondSweep = await shipAction('SWEEP_EXPIRED_QUOTES', {})
    const sweptAgain = await getQuote(sweepOffer.id)
    if (sweptAgain.version === sweptRow.version && sweptAgain.status === 'LOST') {
      ok('a second sweep is idempotent and rewrites nothing', `second pass expired ${secondSweep.expired}; the row is still version ${sweptAgain.version}`)
    } else {
      bad('a second sweep rewrites nothing', `version ${sweptRow.version} → ${sweptAgain.version}`)
    }

    // A plain booking on a load that still has a live request closes it.
    const openRequest = await shipAction('REQUEST_OFFERS', {
      loadId: sweepLoad.id,
      carrierIds: [carrierB.id],
      via: 'COPY',
    })
    const openOffer = openRequest.offers[0]
    noteQuote(String(openOffer.id), 'open offer canceled by a plain booking')
    const sweepLoadNow = (await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: sweepShipmentId })).loads[0]
    await shipAction('BOOK_CARRIER', {
      loadId: sweepLoadNow.id,
      expectedUpdatedAt: sweepLoadNow.updatedAt,
      carrierId: carrierB.id,
      carrierRateCents: 155000,
      acknowledgeWarnings: BOOKING_ACKS,
    })
    const canceledOffer = await getQuote(openOffer.id)
    if (canceledOffer.status === 'CANCELED' && !canceledOffer.quoteOpen && !canceledOffer.linkToken) {
      ok('a plain BOOK_CARRIER cancels the offers still open on that load', `${openOffer.id} ${canceledOffer.status}, link gone`)
    } else {
      bad('a plain BOOK_CARRIER cancels the open offers', JSON.stringify({ status: canceledOffer.status, quoteOpen: canceledOffer.quoteOpen }))
    }

    // ════════════════════════════════════════════════════════════════════════
    // LANE HISTORY
    // ════════════════════════════════════════════════════════════════════════

    let delivered = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: buyShipmentId })
    for (const status of ['PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      const current = delivered.loads[0]
      await shipAction('SET_LOAD_STATUS', { loadId: current.id, status, expectedUpdatedAt: current.updatedAt })
        .catch((err) => console.log(`  (load ${status} skipped: ${String(err.message).slice(0, 70)})`))
      delivered = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: buyShipmentId })
    }

    const deliveredLoad = delivered.loads[0]
    const financials = delivered.financials?.find((f) => f.id === String(deliveredLoad.id)) ?? null
    const sample = await getLaneSample(String(deliveredLoad.id))
    if (sample && financials && sample.laneKey === 'CHICAGO|IL>DALLAS|TX' && sample.loadId === String(deliveredLoad.id)
      && sample.revenueCents === financials.revenueCents && sample.costCents === financials.costCents
      && sample.carrierRateCents === financials.carrierRateCents && sample.carrierRateCents === 160000) {
      ok('a delivered load writes a LaneRateSample with the money off LoadFinancials', `${sample.id} ${sample.laneKey} revenue ${sample.revenueCents} cost ${sample.costCents} margin ${sample.marginBps}bps on ${sample.date}`)
    } else {
      bad('a delivered load writes a LaneRateSample', JSON.stringify({ sample: sample && { id: sample.id, laneKey: sample.laneKey, revenueCents: sample.revenueCents, costCents: sample.costCents, carrierRateCents: sample.carrierRateCents }, financials: financials && { revenueCents: financials.revenueCents, costCents: financials.costCents, carrierRateCents: financials.carrierRateCents } }).slice(0, 280))
    }

    if (sample && sample.assignmentKind === 'CARRIER' && sample.excluded !== true && sample.carrierId === carrierA.id) {
      ok('the sample records the assignment kind the own-fleet exclusion reads', `assignmentKind ${sample.assignmentKind} carrier ${sample.carrierName} excluded ${String(sample.excluded)}`)
    } else {
      bad('the sample records the assignment kind', JSON.stringify({ assignmentKind: sample?.assignmentKind, excluded: sample?.excluded, carrierId: sample?.carrierId }))
    }

    // Revenue moves until the invoice freezes it: a re-price refreshes the sample.
    const repriceCharges = delivered.charges.map((row) => ({
      id: row.id,
      side: row.side,
      code: row.code,
      label: row.label,
      calculatedBy: row.calculatedBy,
      rateCents: row.side === 'CUSTOMER' && row.code === 'LINEHAUL' ? 310000 : row.rateCents,
      count: row.count,
      loadId: row.loadId,
      loadCarrierId: row.loadCarrierId,
    }))
    await shipAction('RECALC_CHARGES', {
      shipmentId: buyShipmentId,
      expectedVersion: delivered.shipment.version,
      charges: repriceCharges,
    })
    const refreshed = await getLaneSample(String(deliveredLoad.id))
    if (refreshed && refreshed.id === sample?.id && refreshed.version === (sample?.version ?? 0) + 1 && refreshed.revenueCents === 310000) {
      ok('a re-price refreshes the sample rather than duplicating it', `${refreshed.id} version ${sample?.version} → ${refreshed.version} revenue ${sample?.revenueCents} → ${refreshed.revenueCents}`)
    } else {
      bad('a re-price refreshes the sample', JSON.stringify({ id: refreshed?.id, version: refreshed?.version, revenueCents: refreshed?.revenueCents, was: sample?.version }))
    }

    const laneRows = await indexQuery(
      'listLaneRateSampleByLaneKeyAndDate',
      '$laneKey: String!, $from: String!',
      'laneKey: $laneKey, date: { ge: $from }',
      { laneKey: 'CHICAGO|IL>DALLAS|TX', from: day(0) },
      'id loadId date revenueCents costCents assignmentKind excluded version',
      200,
    )
    const mine = laneRows.filter((row) => row.loadId === String(deliveredLoad.id))
    if (mine.length === 1) {
      ok('the lane carries exactly one sample for that load', `${mine[0].id} · ${laneRows.length} sample(s) on the lane in total`)
    } else {
      bad('the lane carries exactly one sample for that load', `${mine.length} rows for load ${deliveredLoad.id}`)
    }

  } finally {
    /*
     * Everything this run built, retired here rather than at the end of the happy
     * path: an assertion that threw in the middle must not leave freight standing.
     * Only rows this script created are touched, and the quotes are never deleted
     * at all — a quote number is history, and every row it made is labelled ZZ.
     */
    const standing = []
    for (const row of made.shipments) {
      await retireShipment(row.id, row.label)
      const after = await shipAction('GET_SHIPMENT_BUNDLE', { shipmentId: row.id }).catch(() => null)
      const gone = !!after?.shipment.deletedAt
      if (!gone) standing.push(`${row.number} (${row.id}) — ${row.label}, status ${after?.shipment.status ?? 'unreadable'}`)
    }
    if (standing.length === 0) {
      ok('every fixture shipment was soft-deleted', made.shipments.map((s) => s.number).join(', ') || 'none were built')
    } else {
      bad('every fixture shipment was soft-deleted', `still live: ${standing.join(' · ')}`)
    }

    console.log('\ndev-only rows left behind by this run:')
    console.log(`  customers: ${made.customers.join(' · ') || 'none'}`)
    console.log(`  carriers:  ${made.carriers.join(' · ') || 'none'}`)
    console.log(`  shipments: ${standing.length === 0 ? 'all soft-deleted' : `STILL LIVE — ${standing.join(' · ')}`}`)
    console.log(`  quotes (kept, never deleted): ${made.quotes.join(' · ') || 'none'}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('verification aborted:', err.message ?? err)
  process.exitCode = 1
})
