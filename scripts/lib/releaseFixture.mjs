/**
 * Release-path fixtures for the dev harnesses.
 *
 * Releasing to billing needs the Load Review marker AND the customer's review requirements
 * (default seven: revenue division, reference #, POD received, sales rep, revenue, expense,
 * profit). A harness fixture earns each one through the real app actions:
 *
 *   revenue / expense   customer + carrier charges on SAVE_ORDER_FORM, or ASSIGN/BOOK + RECORD_BILL
 *   reference #         a PO reference on the order (`poReference`)
 *   POD                 the harness's own document upload
 *   sales rep           SET_SALES_REP with a real ACTIVE UserProfile (`findActiveRepId`)
 *   revenue division    SET_REV_TAG with an active division (`DEFAULT_DIVISION`)
 *
 * `bookCarrier` / `enterCarrierCharge` / `recordCarrierBill` put an outside carrier on the load and its bill on the books
 * (the gate refuses an outside leg until its bill is recorded).
 *
 * `releaseForReview` sets the last two, asks the server (REVIEW_LOAD: the same verdict the
 * release enforces) what is still missing, and only then sends the marker. A fixture that is
 * not ready fails here with the server's own sentences, not as a bare refusal mid-harness.
 */

/** The only marker the server accepts on a release. */
export const REVIEW_MARKER = Object.freeze({ source: 'LOAD_REVIEW' })

/** An active division on every environment's taxonomy (hand-tag target). */
export const DEFAULT_DIVISION = 'BROKERAGE'

/** A PO reference row exactly as the order form saves it. */
export function poReference(value) {
  return { code: 'PO', label: 'Purchase order', value: String(value), level: 'ORDER', visibility: 'CUSTOMER' }
}

const REP_ROLE_ORDER = ['CUSTOMER_REP', 'MANAGER', 'ADMIN']

/**
 * The profile a fixture should name as sales rep: ACTIVE, a person (not a throwaway ZZ / temp
 * identity), preferring customer reps. Deterministic: ties break on id.
 */
export function pickActiveRep(profiles) {
  const real = (profiles ?? []).filter((p) => p
    && p.status === 'ACTIVE'
    && typeof p.id === 'string' && p.id !== ''
    && !/^zz|\+zz/i.test(String(p.email ?? '').split('@')[0])
    && !/^zz/i.test(String(p.name ?? '')))
  const rank = (p) => {
    const i = REP_ROLE_ORDER.indexOf(p.role)
    return i === -1 ? REP_ROLE_ORDER.length : i
  }
  real.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  return real[0]?.id ?? null
}

/** The first suitable ACTIVE UserProfile id on the stack `gqlFn(query, variables)` talks to. */
export async function findActiveRepId(gqlFn) {
  const data = await gqlFn('query { listUserProfiles(limit: 1000) { items { id name email role status } } }', {})
  const id = pickActiveRep(data.listUserProfiles.items)
  if (!id) throw new Error('no ACTIVE UserProfile to use as the fixture sales rep')
  return id
}

/** Everything REVIEW_LOAD says is still missing, as sentences (gate refusals first, then the review's own). */
export function reviewGaps(review) {
  const gate = review?.releaseGate?.missing ?? []
  const extras = review?.extras ?? []
  return [...gate, ...extras].map((m) => String(m?.message ?? m?.code ?? m))
}

/**
 * Make the shipment review-ready for the facts only an action can set (rep, division), verify
 * with the server, and release with the Load Review marker. Documents, references and charges
 * must already be on the fixture. Throws `fixture not review-ready: …` listing what is missing.
 * `ship(action, input)` is a routerAs(token, 'tmsShipmentActions') caller.
 */
export async function releaseForReview({ ship, shipmentId, repId, divisionCode = DEFAULT_DIVISION }) {
  if (!repId) throw new Error('releaseForReview needs a repId (see findActiveRepId)')
  let review = await ship('REVIEW_LOAD', { shipmentId })
  // A rep already on the shipment stays; `repId` only fills the gap.
  if (!review.salesRepId) await ship('SET_SALES_REP', { shipmentId, repId })
  if (!review.revDivision) await ship('SET_REV_TAG', { shipmentId, divisionCode })
  review = await ship('REVIEW_LOAD', { shipmentId })
  const gaps = reviewGaps(review)
  if (gaps.length > 0) throw new Error(`fixture not review-ready: ${gaps.join('; ')}`)
  return ship('READY_TO_INVOICE', { orderId: review.orderId, expectedUpdatedAt: review.orderUpdatedAt, review: REVIEW_MARKER })
}

/** The vetted demo carrier every dev stack carries. */
export const DEMO_CARRIER_ID = 'carr-demo-vetted'

/**
 * Book the demo carrier on the shipment's first load at `rateCents`, acknowledging the warnings
 * a fixture always trips (cost over top spend, the carrier's other open loads). Returns the
 * fresh bundle. Do it while the load can still be booked, i.e. before it is walked to delivered.
 */
export async function bookCarrier({ ship, shipmentId, rateCents, carrierId = DEMO_CARRIER_ID, driver = {} }) {
  const bundle = await ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  const load = bundle.loads[0]
  const others = ((await ship('LIST_LOAD_CARRIERS_BY_CARRIER', { carrierId }))?.loadCarriers ?? []).filter((c) => c.status === 'ACTIVE')
  await ship('BOOK_CARRIER', {
    loadId: load.id, carrierId, carrierRateCents: rateCents, expectedUpdatedAt: load.updatedAt,
    driverName: 'ZZ Driver', driverPhone: '+12245550137', ...driver,
    acknowledgeWarnings: ['COST_EXCEEDS_TOP_SPEND', ...others.map((c) => `DOUBLE_BOOKED:${c.loadId}`)],
  })
  return ship('GET_SHIPMENT_BUNDLE', { shipmentId })
}

/**
 * Record the carrier's bill for the shipment's active outside leg (AP side of the expense).
 * `fin(action, input)` is a routerAs(token, 'tmsFinanceActions') caller. Returns the bill row.
 */
export async function recordCarrierBill({ ship, fin, shipmentId, billNumber, billedCents, billDate = new Date().toISOString().slice(0, 10) }) {
  const bundle = await ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  const leg = bundle.loadCarriers.find((c) => c.status === 'ACTIVE')
  if (!leg) throw new Error('no active carrier leg to bill: book a carrier first')
  return (await fin('RECORD_BILL', { loadCarrierId: leg.id, billNumber, billDate, billedCents })).bill
}

/**
 * Put `rateCents` on the active outside leg as its carrier charge (the expense side of the
 * review), replacing that leg's lines. For a leg that exists without a cost, e.g. a seeded one.
 */
export async function enterCarrierCharge({ ship, shipmentId, rateCents, code = 'LINEHAUL' }) {
  const bundle = await ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  const leg = bundle.loadCarriers.find((c) => c.status === 'ACTIVE' && c.kind === 'CARRIER')
  if (!leg) throw new Error('no active outside carrier leg to charge: book a carrier first')
  return ship('UPDATE_CARRIER_CHARGES', {
    loadCarrierId: leg.id,
    expectedVersion: bundle.shipment.version ?? 1,
    charges: [{ side: 'CARRIER', code, rateCents, count: 1 }],
  })
}
