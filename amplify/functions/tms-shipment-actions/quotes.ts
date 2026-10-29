/**
 * Customer quotes — the sell side of step H.
 *
 * One priced thing, ten rungs, one writer per transition. Everything that moves a
 * quote lives here except the two public responses (`tracking-api`), the booking
 * side (`offers.ts`) and the lane history (`laneSamples.ts`).
 *
 * Three rules shape every function below. First, **the number is the id**: it is
 * minted once from the `TmsSettings.nextQuoteNumber` counter with an atomic ADD and
 * written with `attribute_not_exists(id)`, so the counter's race guard and the row's
 * key are the same thing. Second, **`SEND_QUOTE` and `COUNTER_QUOTE` are the only
 * places a `linkToken` is ever written** — a restore, a duplicate and a conversion
 * all leave the row without one, because a live token is a promise somebody can
 * still accept. Third, **a send that SES refuses is reported, not thrown**: SES is
 * denied on dev, the row keeps its token, and the response carries the link and the
 * text so an operator can copy it into their own mail client.
 *
 * The router owns authorization, the clients and the pricing bodies; this module is
 * handed all of them through `QuoteDeps` and re-implements none of them.
 */
import { GetItemCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

import {
  conflictError,
  isConflict,
  marshallRow,
  monthOf,
  nowIso,
  numberOrNull,
  putItem,
  type Bundle,
  type Row,
  type ShipmentStoreDeps,
  type StopShape,
} from '../_shared/shipmentStore'
import { sendNoticeEmail, type SESv2Client } from '../_shared/shipmentNotices'
import {
  assertArrayOf,
  assertString,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalIso,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import { isVoided } from '../_shared/voided'

import { laneKey3For, laneKeyFor } from '../../../src/lib/laneKey'
import {
  LOST_REASONS,
  QUOTE_STATUSES,
  absorbCounter,
  closeSiblings,
  convertInput,
  duplicateQuote,
  isOpenQuoteStatus,
  priceQuoteLines,
  projectedExposureCents,
  quoteExpiry,
  quoteNumber,
  quoteNumberFormatError,
  quoteState,
  type QuotePricingWarning,
} from '../../../src/lib/quotes'
import {
  quoteRecipients,
  quoteTemplateError,
  renderCounterEmail,
  renderQuoteEmail,
} from '../../../src/lib/quoteNotices'
import { newLinkToken } from '../../../src/lib/trackingLink'
import type { CreditSummary } from '../../../src/lib/customerCredit'
import type { Stop } from '../../../src/types'
import type {
  ChargeCalc,
  LoadChargeInput,
  PricingDefaults,
  QuoteEvent,
  QuoteLostReason,
  QuoteRecord,
  QuoteSettings,
  QuoteStatus,
  ShipmentMode,
} from '../../../src/types/tms'

// ── Dependencies ─────────────────────────────────────────────────────────────

/** The charge catalog as `chargeCodeRules` resolves it, keyed by code. */
export type QuoteChargeRules = Record<string, { label: string | null; calculatedBy: ChargeCalc | null }>

/**
 * Extra writes a caller folds into the booking transaction, so an offer is stamped
 * WON by the same transaction that creates the assignment it won.
 */
export interface BookCarrierExtra {
  writes: TransactWriteItem[]
  loadCarrierFields: Row
}

/**
 * What the quote and offer actions need from the router: its clients, its tables,
 * and the pricing and booking bodies they are built on top of. Nothing here is
 * rebuilt locally — one Lambda holds one connection pool and one pricing path.
 */
export interface QuoteDeps {
  db: DynamoDBClient
  ses: SESv2Client
  store: ShipmentStoreDeps
  tables: {
    quote: string
    laneSample: string
    carrierContact: string
    carrier: string
    customer: string
    settings: string
    division: string
    order: string
    load: string
    loadCarrier: string
    loadFinancials: string
    shipment: string
    shipmentNotice: string
  }
  fromAddress: string
  portalOrigin: string
  randomBytes: (size: number) => Uint8Array
  writeAudit: (entityType: string, entityId: string, action: string, caller: Caller, changes: Row) => Promise<void>
  getSettings: () => Promise<Row | null>
  getActiveCustomer: (customerId: string) => Promise<Row>
  getById: (tableName: string, id: string) => Promise<Row | null>
  queryIndex: (tableName: string, indexName: string, keyName: string, keyValue: string) => Promise<Row[]>
  transact: (items: TransactWriteItem[], label: string) => Promise<void>
  readBundle: (shipmentId: string) => Promise<Bundle>
  chargeCodeRules: (settings: Row | null, customer: Row | null) => QuoteChargeRules
  validateChargeInput: (item: unknown, index: number, rules: QuoteChargeRules) => LoadChargeInput
  validateStop: (item: unknown, index: number) => StopShape
  pricingDefaultsOf: (customer: Row | null) => PricingDefaults | null
  marginFloorBpsOf: (settings: Row | null) => number
  /** The CHECK_CREDIT body, exactly as the action runs it. */
  checkCredit: (input: Row) => Promise<Row>
  assertCreditClear: (summary: CreditSummary, customerName: string) => void
  createShipment: (input: Row, caller: Caller) => Promise<Row>
  saveOrderForm: (input: Row, caller: Caller) => Promise<{ bundle: Bundle; totals: { revenueCents: number } }>
  submitOrder: (input: Row, caller: Caller) => Promise<Row>
  bookCarrier: (input: Row, caller: Caller, extra?: BookCarrierExtra) => Promise<Row>
  /**
   * Step R. The rollback a quote may perform. Not a delete — there is no delete:
   * the shipment keeps its PRO and is stamped voided with the reason. Owner/ADMIN is
   * enforced on REVERT_TO_QUOTE in the router's `authorize`, because this is a void.
   */
  voidShipmentForQuote: (shipmentId: string, caller: Caller, reason: string) => Promise<void>
  assertNoInvoicedOrders: (shipmentId: string, verb: string) => Promise<void>
}

// ── Constants ────────────────────────────────────────────────────────────────

// Amplify derives GSI names from the plural model name and the key fields.
export const IDX_QUOTES_BY_CUSTOMER = 'quotesByCustomerIdAndQuoteDate'
export const IDX_QUOTES_BY_LOAD = 'quotesByLoadIdAndQuoteDate'
export const IDX_QUOTES_BY_OPEN = 'quotesByQuoteOpenAndExpiresAt'

const SETTINGS_ID = 'default'
export const SEND_CHANNELS = ['EMAIL', 'COPY'] as const
const RATE_TYPES = ['SPOT', 'CONTRACT'] as const
const ACCEPTED_VIA = ['LINK', 'PHONE', 'EMAIL'] as const
const SHIPMENT_MODES: readonly ShipmentMode[] = [
  'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
]
export const OPEN_STATUSES = QUOTE_STATUSES.filter(isOpenQuoteStatus)

/**
 * `quoteOpen` is indexed WITH `expiresAt` as its sort key, and DynamoDB projects an
 * item into a composite index only when it carries both attributes. A draft has no
 * clock, so it is given one that never strikes: without this the entire open board
 * — the worklist, the drafts tab and the badge — would silently skip every unsent
 * quote. The sweep's `expiresAt < :now` condition can never match it.
 */
export const NO_EXPIRY_SENTINEL = '9999-12-31T23:59:59.999Z'

/** The thread is read with the quote; fifty rungs is more history than anyone opens. */
const MAX_EVENTS = 50
/** One transaction per copy, and ten is the plan's cap. */
export const MAX_DUPLICATE_QUOTES = 10
/** A quote message is a paragraph to a customer, not an essay. */
const MAX_MESSAGE = 4000
const MAX_RECIPIENTS = 20
const BROKER_FALLBACK = 'BCAT Logistics'

// ── Row helpers ──────────────────────────────────────────────────────────────

/**
 * The one place an unmarshalled DynamoDB item is read as a quote. The row came out
 * of the table whose shape the schema declares and the pure libs only read declared
 * fields off it; casting here is the boundary, and there is exactly one of them.
 */
export function quoteRecordOf(row: Row): QuoteRecord {
  return row as unknown as QuoteRecord
}

export function quoteStops(quote: Row): Stop[] {
  return Array.isArray(quote.stops) ? (quote.stops as unknown as Stop[]) : []
}

export function quoteLines(quote: Row): LoadChargeInput[] {
  return Array.isArray(quote.lines) ? (quote.lines as unknown as LoadChargeInput[]) : []
}

/** The thread with one more line on it, oldest dropped once it is full. */
export function pushEvent(quote: Row, event: QuoteEvent): QuoteEvent[] {
  const existing = Array.isArray(quote.events) ? (quote.events as unknown as QuoteEvent[]) : []
  const events = [...existing, event]
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
}

export async function loadQuote(deps: QuoteDeps, quoteId: string): Promise<Row> {
  const quote = await deps.getById(deps.tables.quote, quoteId)
  if (!quote) throw new Error(`Quote not found: ${quoteId}`)
  return quote
}

/** The first pickup appointment on the quote, which is what a BUY expiry is capped at. */
export function firstPickupAppt(stops: Stop[], fallback: string | null): string | null {
  const ordered = [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const pickup = ordered.find((stop) => String(stop.type ?? '').toLowerCase() === 'pickup') ?? ordered[0]
  const appt = typeof pickup?.appt === 'string' ? pickup.appt.trim() : ''
  return appt || fallback
}

/** `${PORTAL_ORIGIN}/quote/${token}` — the SEND_RATE_CON URL shape, one route over. */
export function quoteLinkFor(deps: QuoteDeps, token: string): string {
  return deps.portalOrigin ? `${deps.portalOrigin.replace(/\/+$/, '')}/quote/${token}` : ''
}

/**
 * One division, by the key a load carries.
 *
 * `Division` is identified by `key`, not `id` (`amplify/data/resource.ts`), so it
 * is the one model here that cannot go through `getById`: a GetItem keyed on `id`
 * is a schema mismatch the table refuses outright.
 */
async function divisionRow(deps: QuoteDeps, key: string | null): Promise<Row | null> {
  if (!key || !deps.tables.division) return null
  const result = await deps.db.send(
    new GetItemCommand({ TableName: deps.tables.division, Key: marshall({ key }) }),
  )
  return result.Item ? unmarshall(result.Item) : null
}

/** Whose name signs the e-mail: the division running the freight, or the house name. */
export async function brokerNameFor(deps: QuoteDeps, divisionKey: string | null): Promise<string> {
  const division = await divisionRow(deps, divisionKey)
  return optionalString(division?.name, 120) ?? BROKER_FALLBACK
}

export function quoteSettingsOf(settings: Row | null): QuoteSettings | null {
  return settings as unknown as QuoteSettings | null
}

/**
 * The Quote table's five GSI hash keys (`resource.ts:1922-1932`).
 *
 * DynamoDB refuses a NULL on any of them — `Type mismatch for Index Key` — so a
 * quote with no customer, a quote that is no longer on a load and a row whose link
 * has died do not say so with a null: the attribute comes off the item. A create
 * omits it and an update REMOVEs it, which is also what makes the three sparse
 * indexes sparse.
 */
const QUOTE_INDEX_KEYS: readonly string[] = ['customerId', 'loadId', 'quoteOpen', 'quoteMonth', 'linkToken']

/** A new item without the index keys it has no value for. */
export function omitNullIndexKeys(row: Row): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (value == null && QUOTE_INDEX_KEYS.includes(key)) continue
    out[key] = value
  }
  return out
}

/** The same for a patch: the nulled index keys are taken out and REMOVEd instead. */
export function takeNullIndexKeys(patch: Row): string[] {
  const removed: string[] = []
  for (const key of QUOTE_INDEX_KEYS) {
    if (key in patch && patch[key] == null) {
      delete patch[key]
      removed.push(key)
    }
  }
  return removed
}

// ── Conditional writes ───────────────────────────────────────────────────────

export interface QuoteUpdateOptions {
  /** CAS on `version` when the caller held one; `version` is a reserved word. */
  expectedVersion?: number | null
  remove?: string[]
  statusIn?: readonly QuoteStatus[]
  /** Only write when the row's `expiresAt` is already behind this instant. */
  expiresBefore?: string
}

export interface UpdateSpec {
  TableName: string
  Key: Record<string, AttributeValue>
  UpdateExpression: string
  ExpressionAttributeNames: Record<string, string>
  ExpressionAttributeValues?: Record<string, AttributeValue>
  ConditionExpression?: string
}

/**
 * One guarded update of a quote row.
 *
 * Every write here carries `attribute_exists(id)`: a DynamoDB UpdateItem creates
 * the item it cannot find, and a quote conjured by a typo'd id would have no number,
 * no customer and no way back. The rest of the guards are the transition's own — the
 * rungs it may be made from, the version the caller was holding, the lapsed clock.
 */
export function quoteUpdateSpec(
  tableName: string,
  id: string,
  patch: Row,
  options: QuoteUpdateOptions = {},
): UpdateSpec {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  const removes: string[] = []
  for (const key of options.remove ?? []) {
    // A key on both sides would be two actions on one attribute, which DynamoDB
    // rejects; the patch wins, because it is the explicit value.
    if (key in patch) continue
    names[`#${key}`] = key
    removes.push(`#${key}`)
  }
  const parts: string[] = []
  if (sets.length > 0) parts.push(`SET ${sets.join(', ')}`)
  if (removes.length > 0) parts.push(`REMOVE ${removes.join(', ')}`)

  const conditions = ['attribute_exists(id)']
  if (options.expectedVersion != null) {
    names['#casVersion'] = 'version'
    values[':casVersion'] = { N: String(options.expectedVersion) }
    conditions.push('#casVersion = :casVersion')
  }
  if (options.statusIn && options.statusIn.length > 0) {
    names['#casStatus'] = 'status'
    const tokens = options.statusIn.map((status, i) => {
      values[`:casStatus${i}`] = { S: status }
      return `:casStatus${i}`
    })
    conditions.push(`#casStatus IN (${tokens.join(', ')})`)
  }
  if (options.expiresBefore) {
    names['#casExpiresAt'] = 'expiresAt'
    values[':casExpiresAt'] = { S: options.expiresBefore }
    conditions.push('#casExpiresAt < :casExpiresAt')
  }

  return {
    TableName: tableName,
    Key: marshall({ id }),
    UpdateExpression: parts.join(' '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    ConditionExpression: conditions.join(' AND '),
  }
}

export function quoteUpdateTx(
  tableName: string,
  id: string,
  patch: Row,
  options: QuoteUpdateOptions = {},
): TransactWriteItem {
  return { Update: quoteUpdateSpec(tableName, id, patch, options) }
}

/** The common tail of every quote write: who, when, and the next version. */
export function stamp(quote: Row, caller: Caller, at: string): Row {
  return { updatedBy: caller.email, updatedAt: at, version: (numberOrNull(quote.version) ?? 1) + 1 }
}

/**
 * `expectedVersion` is optional on every quote action: the board fires a sweep and a
 * cancel without holding one, while a form that has a version CASes on it. Absent,
 * the transition's status guard is still the whole guard.
 */
export function expectedVersionOf(input: Row): number | null {
  return optionalInteger(input.expectedVersion, { min: 0, label: 'expectedVersion' })
}

/** A conflicting condition on a quote write is a CAS failure, in those words. */
export async function writeQuote(
  deps: QuoteDeps,
  items: TransactWriteItem[],
  label = 'quote',
): Promise<void> {
  try {
    await deps.transact(items, label)
  } catch (err) {
    if (isConflict(err)) throw conflictError('quote', err)
    throw err
  }
}

// ── The number ───────────────────────────────────────────────────────────────

/**
 * The next quote number, taken with an atomic ADD so two reps quoting in the same
 * second cannot land on the same one — the `nextShipmentNumber`/`nextInvoiceNumber`
 * precedent. The Put that follows carries `attribute_not_exists(id)`, which is the
 * second half of the guarantee: a counter that somehow repeats cannot overwrite.
 */
export async function nextQuoteNumber(deps: QuoteDeps, caller: Caller, quoteDate: string): Promise<string> {
  const now = nowIso()
  const result = await deps.db.send(
    new UpdateItemCommand({
      TableName: deps.tables.settings,
      Key: marshall({ id: SETTINGS_ID }),
      // ADD both increments and seeds, so the first quote on a fresh environment
      // gets Q000001 without anybody having saved settings first.
      UpdateExpression:
        'ADD nextQuoteNumber :one SET createdAt = if_not_exists(createdAt, :now), updatedAt = :now, updatedBy = :by, #tn = if_not_exists(#tn, :tn)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: now },
        ':by': { S: caller.email },
        ':tn': { S: 'TmsSettings' },
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  const settings = result.Attributes ? unmarshall(result.Attributes) : null
  const counter = numberOrNull(settings?.nextQuoteNumber) ?? 1
  return quoteNumber(optionalString(settings?.quoteNumberFormat, 60), counter, quoteDate)
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export interface PricedQuote {
  lines: LoadChargeInput[]
  amountCents: number
  customerRateCents: number
  targetBuyCents: number | null
  topSpendCents: number
  marginBps: number
  warnings: QuotePricingWarning[]
}

/**
 * The quote's numbers, through the same `computeFinancials` the shipment uses, with
 * the customer's own pricing defaults and the org's margin floor applied — so a
 * quote and the shipment it becomes can never disagree about what freight is worth.
 */
export function priceQuote(
  deps: QuoteDeps,
  lines: LoadChargeInput[],
  ctx: { miles?: number | null; weightLbs?: number | null },
  customer: Row | null,
  settings: Row | null,
): PricedQuote {
  const totals = priceQuoteLines(lines, ctx, deps.pricingDefaultsOf(customer), deps.marginFloorBpsOf(settings))
  return {
    lines,
    amountCents: totals.revenueCents,
    customerRateCents: totals.customerRateCents,
    targetBuyCents: totals.targetBuyCents,
    topSpendCents: totals.topSpendCents,
    marginBps: totals.marginBps,
    warnings: totals.warnings,
  }
}

/**
 * The ‡ gate. A number under the customer's minimum or the org's floor is an
 * admin's call while `quoteBelowMinMarginAdminOnly` is on: everybody has to tick the
 * warning, and a rep who ticks it is still refused. The same shape BOOK_CARRIER's
 * gate uses, for the same reason — a finding nobody may overrule is not a checkbox.
 */
export function assertWarningsCleared(
  warnings: QuotePricingWarning[],
  acknowledged: string[],
  caller: Caller,
  settings: Row | null,
  verb: string,
): string[] {
  const adminOnly = warnings.filter((warning) => warning.adminOnly)
  if (adminOnly.length === 0) return []
  const keys = new Set(acknowledged)
  const unacknowledged = adminOnly.filter((warning) => !keys.has(warning.key))
  if (unacknowledged.length > 0) {
    throw new Error(`Acknowledge these before ${verb}ing: ${unacknowledged.map((w) => w.message).join(' ')}`)
  }
  if (settings?.quoteBelowMinMarginAdminOnly !== false && !caller.isAdmin) {
    throw new Error(`Only an admin can ${verb} this quote: ${adminOnly.map((w) => w.message).join(' ')}`)
  }
  return adminOnly.map((warning) => warning.key)
}

function acknowledgedKeys(input: Row): string[] {
  return input.acknowledgeWarnings == null
    ? []
    : assertArrayOf(input.acknowledgeWarnings, 'acknowledgeWarnings', (v, i) =>
        assertString(v, `acknowledgeWarnings[${i}]`))
}

// ── Sending ──────────────────────────────────────────────────────────────────

export interface SendOutcome {
  link: string
  sent: boolean
  subject: string
  body: string
  to: string[]
}

/**
 * Put the e-mail on the wire, and never fail the transition if it will not go.
 *
 * SES is denied on the dev stack, so a refused send is reported: the row keeps its
 * token, `lastSendStatus` stays NOT_SENT and the caller gets the link and the text
 * back to copy. `via: 'COPY'` never touches SES at all.
 */
export async function trySend(
  deps: QuoteDeps,
  args: { to: string[]; cc: string[]; subject: string; body: string; via: 'EMAIL' | 'COPY'; link: string },
): Promise<SendOutcome> {
  const base = { link: args.link, subject: args.subject, body: args.body, to: args.to }
  if (args.via === 'COPY' || args.to.length === 0) return { ...base, sent: false }
  try {
    await sendNoticeEmail(deps.ses, {
      from: deps.fromAddress,
      to: args.to,
      cc: args.cc.length > 0 ? args.cc : undefined,
      subject: args.subject,
      body: args.body,
    })
    return { ...base, sent: true }
  } catch (err) {
    console.error('[tms-shipment-actions] quote email failed', String(err))
    return { ...base, sent: false }
  }
}

/** Mark what SES actually did. Best effort: the transition already happened. */
async function recordSendStatus(deps: QuoteDeps, quoteId: string, sent: boolean): Promise<void> {
  if (!sent) return
  try {
    await deps.db.send(new UpdateItemCommand(quoteUpdateSpec(deps.tables.quote, quoteId, { lastSendStatus: 'SENT' })))
  } catch (err) {
    console.warn('[tms-shipment-actions] quote send status write failed:', String(err))
  }
}

/** A recipient line in an email header; a comma or a newline in one is an attack. */
function assertEmailAddress(value: unknown, label: string): string {
  const v = assertString(value, label)
  if (v.length > 200 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(v)) {
    throw new Error(`${label} must be an email address`)
  }
  return v
}

export function recipientsOf(input: Row, key: 'to' | 'cc'): string[] {
  return input[key] == null
    ? []
    : assertArrayOf(input[key], key, (v, i) => assertEmailAddress(v, `${key}[${i}]`), MAX_RECIPIENTS)
}

/**
 * The lead stage moves with the first quote that goes out, and only forward.
 *
 * Deliberately NOT a transaction item: a customer already past QUOTED fails the
 * condition, and rolling the send back because the CRM had nothing to learn would
 * lose the quote. The send is the thing that must happen; this is bookkeeping.
 */
export async function advanceLeadStage(deps: QuoteDeps, customerId: string | null, caller: Caller): Promise<void> {
  if (!customerId) return
  try {
    await deps.db.send(
      new UpdateItemCommand({
        TableName: deps.tables.customer,
        Key: marshall({ id: customerId }),
        UpdateExpression: 'SET #status = :quoted, updatedBy = :by, updatedAt = :now',
        ConditionExpression: 'attribute_exists(id) AND #status IN (:new, :contacted, :qualified)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':quoted': { S: 'QUOTED' },
          ':new': { S: 'NEW' },
          ':contacted': { S: 'CONTACTED' },
          ':qualified': { S: 'QUALIFIED' },
          ':by': { S: caller.email },
          ':now': { S: nowIso() },
        },
      }),
    )
  } catch (err) {
    if (!isConflict(err)) console.warn('[tms-shipment-actions] lead stage write failed:', String(err))
  }
}

// ── SAVE_QUOTE ───────────────────────────────────────────────────────────────

interface QuoteFormFields {
  stops: Stop[]
  lines: LoadChargeInput[]
  miles: number | null
  weightLbs: number | null
  patch: Row
}

/** Everything the quote form may set, validated once for both create and edit. */
function readForm(deps: QuoteDeps, input: Row, existing: Row | null, rules: QuoteChargeRules): QuoteFormFields {
  const stops = input.stops == null
    ? quoteStops(existing ?? {})
    : (assertArrayOf(input.stops, 'stops', deps.validateStop) as unknown as Stop[])
  const lines = input.lines == null
    ? quoteLines(existing ?? {})
    : assertArrayOf(input.lines, 'lines', (item, i) => deps.validateChargeInput(item, i, rules))
  const miles = input.miles == null
    ? numberOrNull(existing?.miles)
    : optionalInteger(input.miles, { min: 0, label: 'miles' })
  const weightLbs = input.weightLbs == null
    ? numberOrNull(existing?.weightLbs)
    : optionalInteger(input.weightLbs, { min: 0, label: 'weightLbs' })

  const ordered = [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const lastDelivery = [...ordered].reverse().find((stop) => String(stop.type ?? '').toLowerCase() === 'delivery')
  const deliveryAppt = typeof lastDelivery?.appt === 'string' && lastDelivery.appt ? lastDelivery.appt : null

  const patch: Row = {
    stops,
    lines,
    miles,
    weightLbs,
    laneKey: laneKeyFor(stops),
    laneKey3: laneKey3For(stops),
    pickupAppt: optionalIso(input.pickupAppt, 'pickupAppt')
      ?? firstPickupAppt(stops, optionalString(existing?.pickupAppt, 60)),
    deliveryAppt: optionalIso(input.deliveryAppt, 'deliveryAppt')
      ?? deliveryAppt
      ?? optionalString(existing?.deliveryAppt, 60),
    mode: optionalEnum(input.mode, SHIPMENT_MODES, 'mode') ?? optionalString(existing?.mode, 20),
    rateType: optionalEnum(input.rateType, RATE_TYPES, 'rateType') ?? optionalString(existing?.rateType, 20) ?? 'SPOT',
    equipmentType: optionalString(input.equipmentType, 80) ?? optionalString(existing?.equipmentType, 80),
    equipmentLengthFt: optionalInteger(input.equipmentLengthFt, { min: 0, label: 'equipmentLengthFt' })
      ?? numberOrNull(existing?.equipmentLengthFt),
    commodity: optionalString(input.commodity, 200) ?? optionalString(existing?.commodity, 200),
    references: input.references == null
      ? (Array.isArray(existing?.references) ? existing?.references : [])
      : assertArrayOf(input.references, 'references', (item, i) => {
          const reference = item as Row
          return {
            code: assertString(reference?.code, `references[${i}].code`),
            label: optionalString(reference?.label, 120),
            value: assertString(reference?.value, `references[${i}].value`),
            level: optionalString(reference?.level, 40) ?? 'ORDER',
            visibility: optionalString(reference?.visibility, 40) ?? 'INTERNAL',
          }
        }),
    contactName: optionalString(input.contactName, 120) ?? optionalString(existing?.contactName, 120),
    contactEmail: optionalString(input.contactEmail, 200) ?? optionalString(existing?.contactEmail, 200),
    customerRepId: optionalString(input.customerRepId, 100) ?? optionalString(existing?.customerRepId, 100),
    divisionKey: optionalString(input.divisionKey, 100) ?? optionalString(existing?.divisionKey, 100),
    customerMessage: optionalString(input.customerMessage, MAX_MESSAGE)
      ?? optionalString(existing?.customerMessage, MAX_MESSAGE),
    internalNotes: optionalString(input.internalNotes, MAX_MESSAGE)
      ?? optionalString(existing?.internalNotes, MAX_MESSAGE),
  }
  return { stops, lines, miles, weightLbs, patch }
}

/** A customer nobody may quote: the relationship is over, not merely not yet begun. */
const UNQUOTABLE_STATUSES: Record<string, true> = { CLOSED: true, BLOCKED: true }

/**
 * Who may be quoted, which is a wider set than who may be shipped for.
 * `getActiveCustomer` is the gate on building freight and a prospect at NEW would
 * fail it — but quoting a prospect is the entire point of the lead stages, and
 * SEND_QUOTE is what moves one to QUOTED. So a quote asks only that the row still
 * exists, has not been merged away, and is not closed or blocked. The ACTIVE gate
 * is still waiting at CONVERT_QUOTE, where freight actually gets built.
 */
async function getQuotableCustomer(deps: QuoteDeps, customerId: string): Promise<Row> {
  const customer = await deps.getById(deps.tables.customer, customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)
  if (customer.mergedIntoId) throw new Error('That customer has been merged into another record')
  const status = String(customer.status ?? '')
  if (UNQUOTABLE_STATUSES[status] || customer.active === false) {
    throw new Error(`${String(customer.name ?? customerId)} cannot be quoted`)
  }
  return customer
}

/**
 * Create or edit a quote. A create mints the number (judgement 6) and lands DRAFT —
 * or REQUESTED when `intake` is set, which is a request somebody made that we have
 * not priced yet. An edit is refused on every rung but those two: once a number has
 * gone out, the way to change it is to counter it or send it again.
 */
export async function saveQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = optionalString(input.quoteId, 100)
  const settings = await deps.getSettings()
  const existing = quoteId ? await loadQuote(deps, quoteId) : null

  if (existing) {
    const status = String(existing.status ?? '')
    if (status !== 'DRAFT' && status !== 'REQUESTED') {
      throw new Error(`A ${status} quote can no longer be edited — counter it or send it again`)
    }
  }

  const customerId = optionalString(input.customerId, 100) ?? optionalString(existing?.customerId, 100)
  const customer = customerId ? await getQuotableCustomer(deps, customerId) : null
  const rules = deps.chargeCodeRules(settings, customer)
  const form = readForm(deps, input, existing, rules)
  const priced = priceQuote(deps, form.lines, { miles: form.miles, weightLbs: form.weightLbs }, customer, settings)

  const now = nowIso()
  const money: Row = {
    amountCents: priced.amountCents,
    customerRateCents: priced.customerRateCents,
    targetBuyCents: optionalInteger(input.targetBuyCents, { min: 0, label: 'targetBuyCents' }) ?? priced.targetBuyCents,
    topSpendCents: optionalInteger(input.topSpendCents, { min: 0, label: 'topSpendCents' }) ?? priced.topSpendCents,
    marginBps: priced.marginBps,
    pricingWarnings: priced.warnings.map((warning) => warning.key),
  }

  if (existing) {
    const patch: Row = {
      ...form.patch,
      ...money,
      customerId,
      customerName: optionalString(customer?.name, 200) ?? optionalString(existing.customerName, 200),
      ...stamp(existing, caller, now),
    }
    // An intake nobody has named a customer for is a supported quote; what it may
    // not be is a NULL on the `customerId` index key.
    const remove = takeNullIndexKeys(patch)
    await writeQuote(deps, [
      quoteUpdateTx(deps.tables.quote, String(existing.id), patch, {
        expectedVersion: expectedVersionOf(input),
        statusIn: ['DRAFT', 'REQUESTED'],
        remove,
      }),
    ])
    await deps.writeAudit('QUOTE', String(existing.id), 'SAVE_QUOTE', caller, {
      amountCents: priced.amountCents,
      lines: form.lines.length,
    })
    return { quote: await loadQuote(deps, String(existing.id)), pricing: priced } as unknown as Row
  }

  const quoteDate = (optionalIso(input.quoteDate, 'quoteDate') ?? now).slice(0, 10)
  const id = await nextQuoteNumber(deps, caller, quoteDate)
  const intake = optionalBoolean(input.intake) === true
  const row: Row = omitNullIndexKeys({
    id,
    __typename: 'Quote',
    side: 'SELL',
    status: intake ? 'REQUESTED' : 'DRAFT',
    quoteOpen: 'OPEN',
    expiresAt: NO_EXPIRY_SENTINEL,
    groupId: optionalString(input.groupId, 100),
    quoteDate,
    quoteMonth: monthOf(quoteDate) ?? quoteDate.slice(0, 7),
    customerId,
    customerName: optionalString(customer?.name, 200),
    ...form.patch,
    ...money,
    rounds: 0,
    linkVersion: 0,
    requestCount: 0,
    sendCount: 0,
    events: [{ at: now, by: caller.email, kind: intake ? 'REQUESTED' : 'DRAFTED', amountCents: priced.amountCents }],
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  })
  // `attribute_not_exists(id)` is the counter's race guard: two reps who somehow
  // read the same counter cannot both keep the number.
  await writeQuote(deps, [putItem(deps.tables.quote, row)])
  await deps.writeAudit('QUOTE', id, 'SAVE_QUOTE', caller, {
    created: true,
    customerId,
    amountCents: priced.amountCents,
  })
  return { quote: row, pricing: priced } as unknown as Row
}

// ── SEND_QUOTE ───────────────────────────────────────────────────────────────

/**
 * Our number, with a link the customer can answer it on.
 *
 * The only place on the sell side that writes a `linkToken`: DRAFT|REQUESTED climb
 * to QUOTED, and an expired QUOTED|SENT_COUNTER is re-sent with a fresh token and a
 * fresh clock (`quoteState().canSend`). The customer's lead stage moves with it,
 * conditioned and best-effort — see `advanceLeadStage`.
 */
export async function sendQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const via = optionalEnum(input.via, SEND_CHANNELS, 'via') ?? 'EMAIL'
  const message = optionalString(input.message, MAX_MESSAGE)

  const quote = await loadQuote(deps, quoteId)
  if (quote.side !== 'SELL') throw new Error('Use REQUEST_OFFERS to send a carrier an offer')
  const now = nowIso()
  const state = quoteState(quoteRecordOf(quote), now)
  if (!state.canSend) {
    throw new Error(`A ${String(quote.status)} quote cannot be sent — restore it or duplicate it first`)
  }

  const settings = await deps.getSettings()
  const customer = quote.customerId ? await deps.getById(deps.tables.customer, String(quote.customerId)) : null
  const priced = priceQuote(
    deps,
    quoteLines(quote),
    { miles: numberOrNull(quote.miles), weightLbs: numberOrNull(quote.weightLbs) },
    customer,
    settings,
  )
  if (priced.amountCents <= 0) throw new Error('Price this quote before sending it')
  const acknowledged = assertWarningsCleared(priced.warnings, acknowledgedKeys(input), caller, settings, 'send')

  const to = recipientsOf(input, 'to')
  const cc = recipientsOf(input, 'cc')
  const recipients = to.length > 0 ? to : quoteRecipients(quoteRecordOf(quote), null)
  if (recipients.length === 0 && via === 'EMAIL') {
    throw new Error('This quote has no recipient — add a contact e-mail or copy the link instead')
  }

  const token = newLinkToken(deps.randomBytes)
  const quotingDefaults = (customer?.quotingDefaults ?? null) as { hoursToQuote?: number | null } | null
  const expiresAt = quoteExpiry('SELL', now, quotingDefaults, quoteSettingsOf(settings), null)
  const patch: Row = {
    status: 'QUOTED',
    quoteOpen: 'OPEN',
    amountCents: priced.amountCents,
    customerRateCents: priced.customerRateCents,
    // A buy target an operator typed is a decision, not a derived number: the
    // re-price refreshes what we sell for and leaves what we will pay alone.
    targetBuyCents: numberOrNull(quote.targetBuyCents) ?? priced.targetBuyCents,
    topSpendCents: numberOrNull(quote.topSpendCents) ?? priced.topSpendCents,
    marginBps: priced.marginBps,
    pricingWarnings: acknowledged,
    linkToken: token,
    linkVersion: (numberOrNull(quote.linkVersion) ?? 0) + 1,
    requestCount: 0,
    expiresAt,
    sentAt: now,
    sentTo: recipients.join(', '),
    sendCount: (numberOrNull(quote.sendCount) ?? 0) + 1,
    lastSendStatus: 'NOT_SENT',
    response: null,
    respondedAt: null,
    customerMessage: message ?? optionalString(quote.customerMessage, MAX_MESSAGE),
    events: pushEvent(quote, { at: now, by: caller.email, kind: 'SENT', amountCents: priced.amountCents, note: message }),
    ...stamp(quote, caller, now),
  }

  await writeQuote(deps, [
    quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: ['DRAFT', 'REQUESTED', 'QUOTED', 'SENT_COUNTER'],
    }),
  ])
  await advanceLeadStage(deps, optionalString(quote.customerId, 100), caller)

  const saved = await loadQuote(deps, quoteId)
  const link = quoteLinkFor(deps, token)
  const email = renderQuoteEmail({
    quote: quoteRecordOf(saved),
    link,
    brokerName: await brokerNameFor(deps, optionalString(quote.divisionKey, 100)),
    template: optionalString(settings?.quoteEmailTemplate, 8000),
    termsText: optionalString(settings?.quoteTermsText, 8000),
    nowIso: now,
  })
  const outcome = await trySend(deps, { to: recipients, cc, via, link, ...email })
  await recordSendStatus(deps, quoteId, outcome.sent)

  await deps.writeAudit('QUOTE', quoteId, 'SEND_QUOTE', caller, {
    to: recipients, cc, via, sent: outcome.sent, expiresAt, acknowledged,
  })
  return {
    quote: { ...saved, ...(outcome.sent ? { lastSendStatus: 'SENT' } : {}) },
    link: outcome.link || null,
    sent: outcome.sent,
    subject: outcome.subject,
    body: outcome.body,
  } as unknown as Row
}

// ── COUNTER_QUOTE ────────────────────────────────────────────────────────────

/**
 * Our answer to their counter: a new number, a new token, one more round. The
 * previous link died the moment they used it — a quote is one click per round.
 */
export async function counterQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const via = optionalEnum(input.via, SEND_CHANNELS, 'via') ?? 'EMAIL'
  const message = optionalString(input.message, MAX_MESSAGE)
  const amountCents = optionalInteger(input.amountCents, { min: 0, label: 'amountCents' })

  const quote = await loadQuote(deps, quoteId)
  if (quote.side !== 'SELL') throw new Error('Use COUNTER_OFFER to counter a carrier')
  const now = nowIso()
  if (!quoteState(quoteRecordOf(quote), now).canCounter) {
    throw new Error(`A ${String(quote.status)} quote has nothing to counter`)
  }

  const settings = await deps.getSettings()
  const customer = quote.customerId ? await deps.getById(deps.tables.customer, String(quote.customerId)) : null
  const rules = deps.chargeCodeRules(settings, customer)
  const ctx = { miles: numberOrNull(quote.miles), weightLbs: numberOrNull(quote.weightLbs) }
  const lines = input.lines != null
    ? assertArrayOf(input.lines, 'lines', (item, i) => deps.validateChargeInput(item, i, rules))
    : amountCents != null
      ? absorbCounter(quoteLines(quote), amountCents, ctx)
      : quoteLines(quote)
  const priced = priceQuote(deps, lines, ctx, customer, settings)
  if (priced.amountCents <= 0) throw new Error('A counter has to carry a number')
  const acknowledged = assertWarningsCleared(priced.warnings, acknowledgedKeys(input), caller, settings, 'counter')

  const to = recipientsOf(input, 'to')
  const cc = recipientsOf(input, 'cc')
  const recipients = to.length > 0 ? to : quoteRecipients(quoteRecordOf(quote), null)
  const token = newLinkToken(deps.randomBytes)
  const quotingDefaults = (customer?.quotingDefaults ?? null) as { hoursToQuote?: number | null } | null
  const expiresAt = quoteExpiry('SELL', now, quotingDefaults, quoteSettingsOf(settings), null)

  const patch: Row = {
    status: 'SENT_COUNTER',
    quoteOpen: 'OPEN',
    lines: priced.lines,
    amountCents: priced.amountCents,
    customerRateCents: priced.customerRateCents,
    // An operator's own buy target survives a re-price; see SEND_QUOTE.
    targetBuyCents: numberOrNull(quote.targetBuyCents) ?? priced.targetBuyCents,
    topSpendCents: numberOrNull(quote.topSpendCents) ?? priced.topSpendCents,
    marginBps: priced.marginBps,
    pricingWarnings: acknowledged,
    counterCents: null,
    counterBy: 'US',
    rounds: (numberOrNull(quote.rounds) ?? 0) + 1,
    linkToken: token,
    linkVersion: (numberOrNull(quote.linkVersion) ?? 0) + 1,
    requestCount: 0,
    expiresAt,
    sentAt: now,
    sentTo: recipients.join(', '),
    sendCount: (numberOrNull(quote.sendCount) ?? 0) + 1,
    lastSendStatus: 'NOT_SENT',
    response: null,
    respondedAt: null,
    customerMessage: message ?? optionalString(quote.customerMessage, MAX_MESSAGE),
    events: pushEvent(quote, {
      at: now, by: caller.email, kind: 'COUNTERED', amountCents: priced.amountCents, note: message,
    }),
    ...stamp(quote, caller, now),
  }

  await writeQuote(deps, [
    quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: ['RECEIVED_COUNTER'],
    }),
  ])

  const saved = await loadQuote(deps, quoteId)
  const link = quoteLinkFor(deps, token)
  const email = renderCounterEmail({
    quote: quoteRecordOf(saved),
    link,
    brokerName: await brokerNameFor(deps, optionalString(quote.divisionKey, 100)),
    template: optionalString(settings?.counterEmailTemplate, 8000),
    termsText: optionalString(settings?.quoteTermsText, 8000),
    nowIso: now,
  })
  const outcome = await trySend(deps, { to: recipients, cc, via, link, ...email })
  await recordSendStatus(deps, quoteId, outcome.sent)

  await deps.writeAudit('QUOTE', quoteId, 'COUNTER_QUOTE', caller, {
    amountCents: priced.amountCents, rounds: patch.rounds, sent: outcome.sent,
  })
  return {
    quote: { ...saved, ...(outcome.sent ? { lastSendStatus: 'SENT' } : {}) },
    link: outcome.link || null,
    sent: outcome.sent,
    subject: outcome.subject,
    body: outcome.body,
  } as unknown as Row
}

// ── ACCEPT_COUNTER ───────────────────────────────────────────────────────────

/**
 * Take their number. The line haul absorbs the difference and the accessorials are
 * left exactly as they were, so Σ lines still equals `amountCents` and the shipment
 * this becomes prices to the same total.
 */
export async function acceptCounter(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const quote = await loadQuote(deps, quoteId)
  // A carrier's counter is money we pay, and absorbing it into a CUSTOMER line
  // would invent revenue on the buy side. ACCEPT_OFFER books it instead.
  if (quote.side !== 'SELL') throw new Error('Use ACCEPT_OFFER to book a carrier counter')
  const now = nowIso()
  if (!quoteState(quoteRecordOf(quote), now).canAccept) {
    throw new Error(`A ${String(quote.status)} quote has no counter to accept`)
  }
  const counterCents = numberOrNull(quote.counterCents) ?? 0

  const settings = await deps.getSettings()
  const customer = quote.customerId ? await deps.getById(deps.tables.customer, String(quote.customerId)) : null
  const ctx = { miles: numberOrNull(quote.miles), weightLbs: numberOrNull(quote.weightLbs) }
  const priced = priceQuote(deps, absorbCounter(quoteLines(quote), counterCents, ctx), ctx, customer, settings)

  const patch: Row = {
    status: 'RECEIVED_REPLY',
    quoteOpen: 'OPEN',
    lines: priced.lines,
    amountCents: priced.amountCents,
    customerRateCents: priced.customerRateCents,
    // An operator's own buy target survives a re-price; see SEND_QUOTE.
    targetBuyCents: numberOrNull(quote.targetBuyCents) ?? priced.targetBuyCents,
    topSpendCents: numberOrNull(quote.topSpendCents) ?? priced.topSpendCents,
    marginBps: priced.marginBps,
    acceptedVia: 'EMAIL',
    respondedAt: now,
    response: 'ACCEPTED',
    events: pushEvent(quote, { at: now, by: caller.email, kind: 'ACCEPTED_COUNTER', amountCents: priced.amountCents }),
    ...stamp(quote, caller, now),
  }
  await writeQuote(deps, [
    quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: ['RECEIVED_COUNTER'],
      remove: ['linkToken'],
    }),
  ])
  await deps.writeAudit('QUOTE', quoteId, 'ACCEPT_COUNTER', caller, { amountCents: priced.amountCents })
  return { quote: await loadQuote(deps, quoteId) } as unknown as Row
}

// ── Closing rungs ────────────────────────────────────────────────────────────

async function closeQuote(
  deps: QuoteDeps,
  input: Row,
  caller: Caller,
  args: { action: string; status: QuoteStatus; lostReason: QuoteLostReason | null; sellOnly?: boolean },
): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const quote = await loadQuote(deps, quoteId)
  if (args.sellOnly && quote.side !== 'SELL') throw new Error('Only a customer quote can be passed on')
  const status = String(quote.status ?? '')
  if (!isOpenQuoteStatus(status as QuoteStatus)) throw new Error(`That quote is already ${status}`)

  const reason = args.lostReason === null
    ? null
    : optionalEnum(input.reason, LOST_REASONS, 'reason') ?? args.lostReason
  const note = optionalString(input.note, 1000)
  const now = nowIso()
  const patch: Row = {
    status: args.status,
    lostReason: reason,
    lostNote: note,
    closedAt: now,
    events: pushEvent(quote, { at: now, by: caller.email, kind: args.status, note: note ?? reason }),
    ...stamp(quote, caller, now),
  }
  await writeQuote(deps, [
    quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: OPEN_STATUSES,
      remove: ['quoteOpen', 'linkToken'],
    }),
  ])
  await deps.writeAudit('QUOTE', quoteId, args.action, caller, { from: status, reason, note })
  return { quote: await loadQuote(deps, quoteId) } as unknown as Row
}

export function markQuoteLost(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  return closeQuote(deps, input, caller, { action: 'MARK_QUOTE_LOST', status: 'LOST', lostReason: 'NO_REASON' })
}

export function cancelQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  return closeQuote(deps, input, caller, { action: 'CANCEL_QUOTE', status: 'CANCELED', lostReason: null })
}

export function passQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  return closeQuote(deps, input, caller, {
    action: 'PASS_QUOTE', status: 'PASS', lostReason: 'WITHDRAWN', sellOnly: true,
  })
}

/**
 * Back onto the board at QUOTED — and deliberately with **no token**. The customer
 * gets a link again only through `SEND_QUOTE`, which is the one place a token is
 * minted; a restore that resurrected the old link would let an answer from last
 * month land on a quote somebody re-opened today. The clock is the never-striking
 * sentinel, which is what keeps the row in the open board's composite index.
 */
export async function restoreQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const quote = await loadQuote(deps, quoteId)
  if (!quoteState(quoteRecordOf(quote), nowIso()).canRestore) {
    throw new Error(`A ${String(quote.status)} quote cannot be restored`)
  }
  const now = nowIso()
  const patch: Row = {
    status: 'QUOTED',
    quoteOpen: 'OPEN',
    expiresAt: NO_EXPIRY_SENTINEL,
    lostReason: null,
    lostNote: null,
    closedAt: null,
    events: pushEvent(quote, { at: now, by: caller.email, kind: 'RESTORED' }),
    ...stamp(quote, caller, now),
  }
  await writeQuote(deps, [
    quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: ['LOST', 'CANCELED'],
      remove: ['linkToken'],
    }),
  ])
  await deps.writeAudit('QUOTE', quoteId, 'RESTORE_QUOTE', caller, { from: String(quote.status) })
  return { quote: await loadQuote(deps, quoteId) } as unknown as Row
}

// ── SWEEP_EXPIRED_QUOTES ─────────────────────────────────────────────────────

/**
 * Every open sent quote whose hour has passed, moved to LOST EXPIRED.
 *
 * One Query on the sparse `quoteOpen` index and one conditioned UpdateItem per row,
 * never a transaction: the sweep is idempotent and a row somebody answered a second
 * ago must simply be skipped, not take the whole sweep down with it.
 */
export async function sweepExpiredQuotes(deps: QuoteDeps, caller: Caller): Promise<Row> {
  const now = nowIso()
  const open = await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_OPEN, 'quoteOpen', 'OPEN')
  let expired = 0
  for (const quote of open) {
    const status = String(quote.status ?? '')
    const expiresAt = optionalString(quote.expiresAt, 60)
    if (status !== 'QUOTED' && status !== 'SENT_COUNTER') continue
    if (!expiresAt || expiresAt >= now) continue
    const patch: Row = {
      status: 'LOST',
      lostReason: 'EXPIRED',
      closedAt: now,
      events: pushEvent(quote, { at: now, by: caller.email, kind: 'EXPIRED' }),
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(quote.version) ?? 1) + 1,
    }
    try {
      await deps.db.send(
        new UpdateItemCommand(
          quoteUpdateSpec(deps.tables.quote, String(quote.id), patch, {
            statusIn: ['QUOTED', 'SENT_COUNTER'],
            expiresBefore: now,
            remove: ['quoteOpen', 'linkToken'],
          }),
        ),
      )
      expired += 1
    } catch (err) {
      // Somebody answered between the Query and the write. That is the whole point
      // of the condition: their answer stands and the sweep moves on.
      if (!isConflict(err)) throw err
    }
  }
  if (expired > 0) await deps.writeAudit('QUOTE', 'SWEEP', 'SWEEP_EXPIRED_QUOTES', caller, { expired })
  return { expired } as unknown as Row
}

// ── DUPLICATE_QUOTE ──────────────────────────────────────────────────────────

/**
 * The same freight again, for the week after next.
 *
 * Each copy is its own DRAFT with its own number, no token and no `groupId`: these
 * are separate loads on separate days, not one round of competing options, and
 * giving them a group would make converting one close the rest. The response
 * carries what the customer would owe us if every open quote landed — a warning
 * beside the credit limit, never a block.
 */
export async function duplicateQuotes(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const count = optionalInteger(input.count, { min: 1, max: MAX_DUPLICATE_QUOTES, label: 'count' }) ?? 1
  const pickupAppts = input.pickupAppts == null
    ? []
    : assertArrayOf(input.pickupAppts, 'pickupAppts', (v, i) => optionalIso(v, `pickupAppts[${i}]`), MAX_DUPLICATE_QUOTES)

  const source = await loadQuote(deps, quoteId)
  const now = nowIso()
  const quoteDate = now.slice(0, 10)
  const quotes: Row[] = []
  for (let i = 0; i < count; i += 1) {
    const copy = duplicateQuote(quoteRecordOf(source), { pickupAppt: pickupAppts[i] ?? null })
    const id = await nextQuoteNumber(deps, caller, quoteDate)
    // `duplicateQuote` copies every field as a value, nulls included; a copy of a
    // customer-less quote must still not carry a NULL on an index key.
    const row: Row = omitNullIndexKeys({
      ...(copy as unknown as Row),
      id,
      __typename: 'Quote',
      quoteDate,
      quoteMonth: monthOf(quoteDate) ?? quoteDate.slice(0, 7),
      expiresAt: NO_EXPIRY_SENTINEL,
      linkVersion: 0,
      requestCount: 0,
      sendCount: 0,
      events: [{ at: now, by: caller.email, kind: 'DUPLICATED', note: quoteId }],
      createdBy: caller.email,
      updatedBy: caller.email,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    await writeQuote(deps, [putItem(deps.tables.quote, row)])
    quotes.push(row)
  }

  const customerId = optionalString(source.customerId, 100)
  const customer = customerId ? await deps.getById(deps.tables.customer, customerId) : null
  const creditLimitCents = numberOrNull(customer?.creditLimitCents)
  let projectedCents = 0
  if (customerId) {
    const siblings = await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_CUSTOMER, 'customerId', customerId)
    const summary = (await deps.checkCredit({ customerId, projectedCents: 0 })) as unknown as CreditSummary
    projectedCents = projectedExposureCents(siblings.map(quoteRecordOf), summary.usedCents ?? 0)
  }

  await deps.writeAudit('QUOTE', quoteId, 'DUPLICATE_QUOTE', caller, { count, ids: quotes.map((q) => String(q.id)) })
  return {
    quotes,
    exposure: {
      projectedCents,
      creditLimitCents,
      overLimit: creditLimitCents != null && projectedCents > creditLimitCents,
    },
  } as unknown as Row
}

// ── CONVERT_QUOTE ────────────────────────────────────────────────────────────

/** The group this quote belongs to, for `closeSiblings`. Never the whole table. */
async function siblingsOf(deps: QuoteDeps, quote: Row): Promise<Row[]> {
  const groupId = optionalString(quote.groupId, 100)
  if (!groupId) return []
  const loadId = optionalString(quote.loadId, 100)
  const customerId = optionalString(quote.customerId, 100)
  const rows = loadId
    ? await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_LOAD, 'loadId', loadId)
    : customerId
      ? await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_CUSTOMER, 'customerId', customerId)
      : []
  return rows.filter((row) => optionalString(row.groupId, 100) === groupId)
}

/** The sibling closes, as transaction items. Priced → LOST, unpriced → CANCELED. */
export function siblingCloseWrites(
  deps: QuoteDeps,
  siblings: Row[],
  winnerId: string,
  caller: Caller,
  now: string,
): TransactWriteItem[] {
  return closeSiblings(siblings.map(quoteRecordOf), winnerId).map((close) =>
    quoteUpdateTx(
      deps.tables.quote,
      close.id,
      {
        status: close.status,
        lostReason: close.lostReason,
        closedAt: now,
        updatedBy: caller.email,
        updatedAt: now,
      },
      { statusIn: OPEN_STATUSES, remove: ['quoteOpen', 'linkToken'] },
    ),
  )
}

/**
 * A division key the convert dialog offered, confirmed against the table.
 *
 * The key is written onto the load, where the board, the division filter and every
 * month-end split read it. `brokerNameFor` can fall back to the house name when a
 * key resolves to nothing, but a load cannot: a typo would file the freight under a
 * division that does not exist and nothing downstream would ever say so. The dialog
 * offers active divisions only, and this is the same list read from the table.
 */
async function assertKnownDivision(deps: QuoteDeps, divisionKey: string): Promise<void> {
  const division = await divisionRow(deps, divisionKey)
  if (!division) throw new Error(`Unknown division: ${divisionKey}`)
  if (division.active === false) throw new Error(`That division is closed: ${divisionKey}`)
}

/**
 * The quote becomes freight.
 *
 * WON is written by the transaction that writes the Order, and by nothing else: a
 * quote the customer never took must never reach the board, the status GSIs or the
 * lane history. Everything before that final transaction is the ordinary shipment
 * path — `CREATE_SHIPMENT`, `SAVE_ORDER_FORM`, `SUBMIT_ORDER` — so a converted quote
 * is indistinguishable from an order somebody typed, down to the charge lines. If
 * the shipment prices to anything other than the quote's number, or anything at all
 * fails, the half-made shipment is voided — never deleted, its PRO was already
 * taken — and the quote is left where it was.
 *
 * `divisionKey` and `customerRepId` are the two things the convert dialog lets an
 * operator change on the way through: the order is written under the rep given and
 * the leg under the division given, both recorded on the quote's thread because the
 * quote itself keeps the header it was quoted with.
 */
export async function convertQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const acceptedVia = optionalEnum(input.acceptedVia, ACCEPTED_VIA, 'acceptedVia')
  // What the convert dialog offers on top of the quote's own header: the division
  // the freight runs under and the rep who owns the order it becomes. Absent, the
  // quote's own values stand and the load keeps the customer's default division.
  const divisionOverride = optionalString(input.divisionKey, 100)
  const repOverride = optionalString(input.customerRepId, 100)

  const quote = await loadQuote(deps, quoteId)
  if (quote.side !== 'SELL') throw new Error('Use ACCEPT_OFFER to book a carrier offer')
  const state = quoteState(quoteRecordOf(quote), nowIso())
  if (!state.canConvert) {
    throw new Error(
      state.expired
        ? 'That quote has expired — send it again before converting it'
        : `A ${String(quote.status)} quote cannot be converted`,
    )
  }
  const amountCents = numberOrNull(quote.amountCents) ?? 0
  const ci = convertInput(quoteRecordOf(quote))

  // An override is checked before anything is written, for the same reason the
  // credit gate below is: a refusal costs nothing, a rollback costs a shipment.
  if (divisionOverride) await assertKnownDivision(deps, divisionOverride)

  // The credit gate first: a customer over their limit is refused before anything
  // is written, exactly as SUBMIT_ORDER would have refused them a moment later.
  const customer = await deps.getActiveCustomer(ci.customerId)
  const summary = (await deps.checkCredit({
    customerId: ci.customerId,
    projectedCents: amountCents,
  })) as unknown as CreditSummary
  deps.assertCreditClear(summary, String(customer.name ?? ci.customerId))

  const created = (await deps.createShipment({ customerId: ci.customerId, mode: ci.mode }, caller)) as unknown as Bundle
  const shipmentId = String(created.shipment.id)
  const form: Row = {
    shipmentId,
    stops: ci.stops as unknown as Row[],
    order: {
      equipmentType: ci.equipmentType,
      equipmentLengthFt: ci.equipmentLengthFt,
      rateType: ci.rateType ?? 'SPOT',
      references: ci.references,
      internalNotes: ci.quoteNotes,
      customerRepId: repOverride ?? optionalString(quote.customerRepId, 100),
    },
    charges: ci.lines as unknown as Row[],
    loadFields: { miles: ci.miles, weight: ci.weightLbs, commodity: ci.commodity },
  }

  try {
    const saved = await deps.saveOrderForm(
      { ...form, expectedUpdatedAt: String(created.shipment.updatedAt ?? '') },
      caller,
    )
    // The quote and the order are priced by the same function from the same lines,
    // so a difference here means the lines no longer mean what they meant — a charge
    // code whose calc changed, a customer override added since. Refuse and roll back.
    if (saved.totals.revenueCents !== amountCents) {
      throw new Error(
        `This quote prices to ${(saved.totals.revenueCents / 100).toFixed(2)} today, not the ${(amountCents / 100).toFixed(2)} it was quoted at — re-price the quote first`,
      )
    }
    await deps.submitOrder({ ...form }, caller)
  } catch (err) {
    await deps.voidShipmentForQuote(
      shipmentId,
      caller,
      `Quote conversion failed: ${err instanceof Error ? err.message : String(err)}`,
    ).catch((cleanupErr) => console.error('[tms-shipment-actions] convert rollback failed:', String(cleanupErr)))
    throw err
  }

  const bundle = await deps.readBundle(shipmentId)
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const siblings = await siblingsOf(deps, quote)
  const wonAt = nowIso()
  // What the convert was filed under, where it differs from what the quote carried.
  // The quote keeps its own header; the thread is what explains the load's.
  const overrides = [
    divisionOverride && divisionOverride !== optionalString(quote.divisionKey, 100)
      ? `division ${divisionOverride}` : '',
    repOverride && repOverride !== optionalString(quote.customerRepId, 100)
      ? `rep ${repOverride}` : '',
  ].filter(Boolean)
  const quotePatch: Row = {
    status: 'WON',
    wonAt,
    closedAt: wonAt,
    shipmentId,
    shipmentNumber: optionalString(bundle.shipment.number, 60),
    orderId: optionalString(order?.id, 100),
    loadId: optionalString(load?.id, 100),
    loadNumber: optionalString(load?.loadNumber, 60),
    acceptedVia: acceptedVia ?? optionalString(quote.acceptedVia, 20) ?? 'PHONE',
    events: pushEvent(quote, {
      at: wonAt,
      by: caller.email,
      kind: 'WON',
      amountCents,
      note: overrides.length > 0 ? `Converted under ${overrides.join(' and ')}` : null,
    }),
    ...stamp(quote, caller, wonAt),
  }

  try {
    await deps.transact(
      [
        quoteUpdateTx(deps.tables.quote, quoteId, quotePatch, {
          expectedVersion: expectedVersionOf(input),
          statusIn: ['QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY'],
          remove: ['quoteOpen', 'linkToken'],
        }),
        {
          Update: quoteUpdateSpec(deps.tables.order, String(order?.id ?? ''), {
            quoteId,
            quoteNumber: quoteId,
            quoteAmountCents: amountCents,
            quoteNotes: ci.quoteNotes,
            rateType: ci.rateType ?? 'SPOT',
            updatedBy: caller.email,
            updatedAt: wonAt,
          }),
        },
        ...siblingCloseWrites(deps, siblings, quoteId, caller, wonAt),
        // The division the dialog chose lands on the leg in the same transaction
        // that writes WON: the load `createShipment` made carries the customer's
        // default, which is the right answer only when nobody said otherwise.
        ...(divisionOverride && load?.id
          ? [quoteUpdateTx(deps.tables.load, String(load.id), {
            divisionKey: divisionOverride,
            updatedBy: caller.email,
            updatedAt: wonAt,
          })]
          : []),
      ],
      'quote conversion',
    )
  } catch (err) {
    await deps.voidShipmentForQuote(
      shipmentId,
      caller,
      `Quote conversion failed: ${err instanceof Error ? err.message : String(err)}`,
    ).catch((cleanupErr) => console.error('[tms-shipment-actions] convert rollback failed:', String(cleanupErr)))
    if (isConflict(err)) throw conflictError('quote', err)
    throw err
  }

  await deps.writeAudit('QUOTE', quoteId, 'CONVERT_QUOTE', caller, {
    shipmentId, orderId: String(order?.id ?? ''), amountCents,
  })
  await deps.writeAudit('SHIPMENT', shipmentId, 'CONVERT_QUOTE', caller, { quoteId, amountCents })
  return { quote: await loadQuote(deps, quoteId), bundle: await deps.readBundle(shipmentId) } as unknown as Row
}

// ── REVERT_TO_QUOTE ──────────────────────────────────────────────────────────

/**
 * The only way back out of a conversion: the shipment is voided and the quote
 * returns to RECEIVED_REPLY — "they accepted, we have not built it". Refused on
 * anything that has moved: a second leg, a carrier on the truck, a bill or an
 * invoice. Those are facts about freight, and freight cannot become a quote again.
 *
 * It voids a shipment, so it is owner/ADMIN only (`QUOTE_ADMIN_ONLY_ACTIONS`); the
 * PRO survives the revert and is never handed to the next quote.
 *
 * Either id identifies the pair — the quote page holds the quote, the shipment page
 * holds the shipment — and the two must agree when both are given.
 */
export async function revertToQuote(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const reason = assertString(input.reason, 'reason').slice(0, 500)
  const askedShipmentId = optionalString(input.shipmentId, 100)
  const askedQuoteId = optionalString(input.quoteId, 100)
  if (!askedShipmentId && !askedQuoteId) throw new Error('shipmentId or quoteId is required')

  const quoteFirst = askedQuoteId ? await loadQuote(deps, askedQuoteId) : null
  const shipmentId = askedShipmentId ?? optionalString(quoteFirst?.shipmentId, 100)
  if (!shipmentId) throw new Error(`Quote ${String(askedQuoteId)} has no shipment to revert`)

  const bundle = await deps.readBundle(shipmentId)
  if (isVoided(bundle.shipment)) throw new Error('That shipment is already voided')
  if (bundle.orders.length !== 1 || bundle.loads.length !== 1) {
    throw new Error('Only a single-order, single-load shipment can go back to being a quote')
  }
  const order = bundle.orders[0]
  const quoteId = optionalString(order.quoteId, 100)
  if (!quoteId) throw new Error('That shipment did not come from a quote')
  if (askedQuoteId && askedQuoteId !== quoteId) {
    throw new Error(`Shipment ${shipmentId} came from quote ${quoteId}, not ${askedQuoteId}`)
  }
  const held = bundle.loadCarriers.find((row) => row.status === 'ACTIVE' || row.status === 'TONU')
  if (held) {
    throw new Error(`${String(held.carrierName ?? 'A carrier')} is on this shipment; remove them first, then revert it`)
  }
  await deps.assertNoInvoicedOrders(shipmentId, 'revert')

  const quote = quoteFirst ?? await loadQuote(deps, quoteId)
  if (quote.status !== 'WON') throw new Error(`Quote ${quoteId} is ${String(quote.status)}, not WON`)

  const now = nowIso()
  const patch: Row = {
    status: 'RECEIVED_REPLY',
    quoteOpen: 'OPEN',
    expiresAt: NO_EXPIRY_SENTINEL,
    shipmentNumber: null,
    loadNumber: null,
    wonAt: null,
    closedAt: null,
    events: pushEvent(quote, { at: now, by: caller.email, kind: 'REVERTED', note: reason }),
    ...stamp(quote, caller, now),
  }
  // The quote comes back first, and the shipment it pointed at goes second: a
  // revert that deleted the freight and then failed would strand the quote at WON
  // with nothing under it and no way back. `loadId` is the hash key of
  // `quotesByLoadIdAndQuoteDate`, so it — and the two ids beside it — come off the
  // row with REMOVE; SET null is the error DynamoDB calls `Type mismatch for
  // Index Key`.
  await writeQuote(deps, [
    quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: ['WON'],
      remove: ['shipmentId', 'orderId', 'loadId'],
    }),
  ])
  await deps.voidShipmentForQuote(shipmentId, caller, `Reverted to quote ${quoteId}: ${reason}`)
  await deps.writeAudit('QUOTE', quoteId, 'REVERT_TO_QUOTE', caller, { shipmentId, reason })
  await deps.writeAudit('SHIPMENT', shipmentId, 'REVERT_TO_QUOTE', caller, { quoteId, reason })
  return { quote: await loadQuote(deps, quoteId) } as unknown as Row
}

// ── SAVE_QUOTE_SETTINGS ──────────────────────────────────────────────────────

const TEMPLATE_FIELDS = ['quoteEmailTemplate', 'counterEmailTemplate', 'offerRequestEmailTemplate'] as const

/**
 * The quotes half of `TmsSettings`. Three rules, all of them about not breaking a
 * link somebody is waiting on: a template with no `{link}` cannot be answered, a
 * number format with no `{n}` would hand every quote the same id (and the id is the
 * key), and the counter may only ever go up — lowering it points the next quote at
 * a number that already exists, whose Put is then refused.
 */
export async function saveQuoteSettings(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const settings = await deps.getSettings()
  const patch: Row = {}

  for (const field of TEMPLATE_FIELDS) {
    if (!(field in input)) continue
    const template = optionalString(input[field], 8000)
    const error = quoteTemplateError(template)
    if (error) throw new Error(error)
    patch[field] = template
  }
  if ('quoteNumberFormat' in input) {
    const format = optionalString(input.quoteNumberFormat, 60)
    const error = quoteNumberFormatError(format)
    if (error) throw new Error(error)
    patch.quoteNumberFormat = format
  }
  if ('nextQuoteNumber' in input) {
    const next = optionalInteger(input.nextQuoteNumber, { min: 0, label: 'nextQuoteNumber' })
    const current = numberOrNull(settings?.nextQuoteNumber) ?? 0
    if (next != null && next < current) {
      throw new Error(`The quote counter is at ${current} and can only go forward`)
    }
    if (next != null) patch.nextQuoteNumber = next
  }
  if ('hoursToQuote' in input) {
    patch.hoursToQuote = optionalInteger(input.hoursToQuote, { min: 1, max: 8760, label: 'hoursToQuote' })
  }
  if ('offerExpiryHours' in input) {
    patch.offerExpiryHours = optionalInteger(input.offerExpiryHours, { min: 1, max: 8760, label: 'offerExpiryHours' })
  }
  if ('quoteTermsText' in input) patch.quoteTermsText = optionalString(input.quoteTermsText, 8000)
  if ('quoteBelowMinMarginAdminOnly' in input) {
    patch.quoteBelowMinMarginAdminOnly = optionalBoolean(input.quoteBelowMinMarginAdminOnly)
  }
  if ('quoteOffersCarrierSeesBookNow' in input) {
    patch.quoteOffersCarrierSeesBookNow = optionalBoolean(input.quoteOffersCarrierSeesBookNow)
  }
  if (Object.keys(patch).length === 0) throw new Error('Nothing to save')

  // The settings singleton is created by the directory router; here it is patched,
  // seeding `__typename` the way every counter write on this row already does.
  const names: Record<string, string> = { '#tn': '__typename' }
  const values: Record<string, AttributeValue> = { ':tn': { S: 'TmsSettings' } }
  const sets = ['#tn = if_not_exists(#tn, :tn)']
  for (const [key, value] of Object.entries({ ...patch, updatedBy: caller.email, updatedAt: nowIso() })) {
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  await deps.db.send(
    new UpdateItemCommand({
      TableName: deps.tables.settings,
      Key: marshall({ id: SETTINGS_ID }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  )
  await deps.writeAudit('TMS_SETTINGS', SETTINGS_ID, 'SAVE_QUOTE_SETTINGS', caller, patch)
  return { settings: await deps.getById(deps.tables.settings, SETTINGS_ID) } as unknown as Row
}
