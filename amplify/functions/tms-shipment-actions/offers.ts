/**
 * Carrier offers — the buy side of step H.
 *
 * The same `Quote` model and the same ten rungs as the sell side, read in the
 * carrier's words: Booked is WON, Not booked is LOST, Carrier pass is PASS. What
 * differs is who answers and what an answer may do. **A carrier's acceptance never
 * books**: a public POST has no identity, no insurance check and no double-booking
 * check, so it lands RECEIVED_REPLY and a dispatcher clicks Accept — which runs the
 * ordinary `BOOK_CARRIER` gate, with its refusals coming back verbatim.
 *
 * An offer request is a `ShipmentNotice` per carrier (`kind: 'CARRIER_OFFER'`)
 * through the shared `deliverNotice`, which already records a dev NOT_SENT on the
 * row instead of throwing. A covered load never shows a live request: booking a
 * carrier, assigning one by name or putting our own truck on it all cancel whatever
 * offers are still open.
 */
import { UpdateItemCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { randomUUID } from 'crypto'

import {
  isConflict,
  monthOf,
  nowIso,
  numberOrNull,
  putItem,
  readStops,
  type Row,
} from '../_shared/shipmentStore'
import { deliverNotice } from '../_shared/shipmentNotices'
import {
  assertArrayOf,
  assertString,
  optionalEnum,
  optionalInteger,
  optionalIso,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'

import { laneKey3For, laneKeyFor, type LaneAliasMap } from '../../../src/lib/laneKey'
import { aliasMap } from '../../../src/lib/integrations/postalAliases'
import { LOST_REASONS, isOpenQuoteStatus, quoteExpiry } from '../../../src/lib/quotes'
import { renderOfferRequestEmail } from '../../../src/lib/quoteNotices'
import { MOVEMENT_RANK } from '../../../src/lib/shipmentStatus'
import { newLinkToken } from '../../../src/lib/trackingLink'
import type { Stop } from '../../../src/types'
import type { LoadWorkflowStatus, QuoteStatus } from '../../../src/types/tms'
import {
  IDX_QUOTES_BY_LOAD,
  NO_EXPIRY_SENTINEL,
  OPEN_STATUSES,
  SEND_CHANNELS,
  brokerNameFor,
  expectedVersionOf,
  firstPickupAppt,
  loadQuote,
  nextQuoteNumber,
  pushEvent,
  quoteLinkFor,
  quoteRecordOf,
  quoteSettingsOf,
  quoteUpdateSpec,
  quoteUpdateTx,
  siblingCloseWrites,
  stamp,
  trySend,
  writeQuote,
  type QuoteDeps,
} from './quotes'

/** Amplify derives GSI names from the plural model name and the key fields. */
const IDX_CONTACTS_BY_CARRIER = 'carrierContactsByCarrierId'
const IDX_CARRIERS_BY_LOAD = 'loadCarriersByLoadId'

/** One request round goes to a shortlist, not to the whole directory. */
const MAX_REQUEST_CARRIERS = 25
const MAX_MESSAGE = 4000
/** A load past this has a truck under it; nobody is still shopping it. */
const LAST_REQUESTABLE_RANK = MOVEMENT_RANK.DISPATCHED

/** The rungs a dispatcher may book an offer from: somebody has named a number. */
const BOOKABLE_STATUSES: readonly QuoteStatus[] = ['QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY', 'RECEIVED_COUNTER']
/** The rungs we may counter from: the carrier has spoken and it is our move. */
const COUNTERABLE_STATUSES: readonly QuoteStatus[] = ['QUOTED', 'RECEIVED_COUNTER']

// ── Load reads ───────────────────────────────────────────────────────────────

interface OfferLoad {
  load: Row
  shipmentId: string
  stops: Stop[]
  pickupAppt: string | null
}

/**
 * The leg an offer covers, with the two refusals that make a request honest: a load
 * already covered and a load already on the road are not freight anybody can bid on.
 */
async function requestableLoad(deps: QuoteDeps, loadId: string): Promise<OfferLoad> {
  const load = await deps.getById(deps.tables.load, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')

  const status = String(load.status ?? 'SOURCING')
  const rank = status in MOVEMENT_RANK ? MOVEMENT_RANK[status as LoadWorkflowStatus] : -1
  if (rank > LAST_REQUESTABLE_RANK) {
    throw new Error(`That load is already ${status}; there is nothing left to ask a carrier for`)
  }
  const assignments = await deps.queryIndex(deps.tables.loadCarrier, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  if (assignments.some((row) => row.status === 'ACTIVE')) {
    throw new Error('That load already has an active assignment')
  }

  const stops = readStops(load) as unknown as Stop[]
  return { load, shipmentId, stops, pickupAppt: firstPickupAppt(stops, optionalString(load.pickupAppt, 60)) }
}

/** Where an offer is addressed: the carrier's dispatch desk, then whatever it has. */
async function carrierRecipients(deps: QuoteDeps, carrier: Row): Promise<string[]> {
  const out: string[] = []
  const add = (value: unknown): void => {
    const email = String(value ?? '').trim().toLowerCase()
    if (!email.includes('@') || out.includes(email)) return
    out.push(email)
  }
  if (deps.tables.carrierContact) {
    const contacts = await deps.queryIndex(
      deps.tables.carrierContact, IDX_CONTACTS_BY_CARRIER, 'carrierId', String(carrier.id),
    )
    for (const contact of contacts) {
      if (contact.active === false) continue
      const types = Array.isArray(contact.types) ? contact.types.map((t) => String(t).toUpperCase()) : []
      if (!types.includes('DISPATCH')) continue
      add(contact.email)
    }
  }
  // The row's own desk is the fallback, not a second choice: a small carrier has
  // one e-mail address and no contact rows at all.
  if (out.length === 0) {
    add(carrier.dispatcherEmail)
    add(carrier.email)
  }
  return out
}

/** The shape every BUY row shares, whether it came from a request or a phone call. */
function offerRow(args: {
  id: string
  groupId: string | null
  leg: OfferLoad
  carrier: Row
  carrierEmail: string | null
  amountCents: number
  bookNowRateCents: number | null
  status: QuoteStatus
  expiresAt: string
  caller: Caller
  now: string
  message: string | null
  event: string
  /** The org's postal-code aliases, so one facility keeps one lane key. */
  aliases: LaneAliasMap | null
}): Row {
  const { leg, carrier, caller, now } = args
  const quoteDate = now.slice(0, 10)
  return {
    id: args.id,
    __typename: 'Quote',
    side: 'BUY',
    status: args.status,
    quoteOpen: 'OPEN',
    groupId: args.groupId,
    quoteDate,
    quoteMonth: monthOf(quoteDate) ?? quoteDate.slice(0, 7),
    carrierId: String(carrier.id),
    carrierName: optionalString(carrier.name, 200),
    carrierMc: optionalString(carrier.mcNumber, 40),
    carrierEmail: args.carrierEmail,
    shipmentId: leg.shipmentId,
    loadId: String(leg.load.id),
    loadNumber: optionalString(leg.load.loadNumber, 60),
    divisionKey: optionalString(leg.load.divisionKey, 100),
    equipmentType: optionalString(leg.load.equipmentType, 80),
    stops: leg.stops,
    laneKey: laneKeyFor(leg.stops, args.aliases),
    laneKey3: laneKey3For(leg.stops),
    pickupAppt: leg.pickupAppt,
    deliveryAppt: optionalString(leg.load.deliveryAppt, 60),
    commodity: optionalString(leg.load.commodity, 200),
    weightLbs: numberOrNull(leg.load.weight),
    miles: numberOrNull(leg.load.miles),
    amountCents: args.amountCents,
    bookNowRateCents: args.bookNowRateCents,
    rounds: 0,
    expiresAt: args.expiresAt,
    linkVersion: 0,
    requestCount: 0,
    sendCount: 0,
    customerMessage: args.message,
    events: [{ at: now, by: caller.email, kind: args.event, amountCents: args.amountCents }],
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

// ── REQUEST_OFFERS ───────────────────────────────────────────────────────────

/**
 * Ask a shortlist of carriers what they want for this load.
 *
 * One REQUESTED row per carrier under one `groupId` — that group is what
 * `closeSiblings` closes when one of them is booked — each with its own token, so
 * one carrier's answer can never land on another's row. The clock is capped at the
 * first pickup: an offer that outlives the load invites somebody to accept freight
 * that left without them.
 */
export async function requestOffers(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const carrierIds = assertArrayOf(
    input.carrierIds, 'carrierIds', (v, i) => assertString(v, `carrierIds[${i}]`), MAX_REQUEST_CARRIERS,
  )
  if (carrierIds.length === 0) throw new Error('Pick at least one carrier to ask')
  const via = optionalEnum(input.via, SEND_CHANNELS, 'via') ?? 'EMAIL'
  const message = optionalString(input.message, MAX_MESSAGE)
  const bookNowRateCents = optionalInteger(input.bookNowRateCents, { min: 0, label: 'bookNowRateCents' })

  const leg = await requestableLoad(deps, loadId)
  const settings = await deps.getSettings()
  const showBookNow = settings?.quoteOffersCarrierSeesBookNow !== false
  const now = nowIso()
  const expiresAt = optionalIso(input.expiresAt, 'expiresAt')
    ?? quoteExpiry('BUY', now, null, quoteSettingsOf(settings), leg.pickupAppt)
  const groupId = `qgr-${randomUUID()}`
  const brokerName = await brokerNameFor(deps, optionalString(leg.load.divisionKey, 100))

  const offers: Row[] = []
  const sends: Row[] = []
  for (const carrierId of new Set(carrierIds)) {
    const carrier = await deps.getById(deps.tables.carrier, carrierId)
    if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)
    const to = await carrierRecipients(deps, carrier)
    const token = newLinkToken(deps.randomBytes)
    const id = await nextQuoteNumber(deps, caller, now.slice(0, 10))
    const row = offerRow({
      id,
      groupId,
      leg,
      carrier,
      carrierEmail: to[0] ?? null,
      // What a carrier may take outright — and only while the org shows it. With
      // `quoteOffersCarrierSeesBookNow` off the request carries no number at all:
      // nothing is printed as our offer, and `planResponse` has nothing to accept.
      amountCents: showBookNow ? bookNowRateCents ?? 0 : 0,
      bookNowRateCents: showBookNow ? bookNowRateCents : null,
      status: 'REQUESTED',
      expiresAt,
      caller,
      now,
      message,
      event: 'REQUESTED',
      aliases: aliasMap(settings?.postalCodeAliases as Parameters<typeof aliasMap>[0]),
    })
    row.linkToken = token
    row.linkVersion = 1
    row.sentAt = now
    row.sentTo = to.join(', ')
    row.sendCount = 1
    row.lastSendStatus = 'NOT_SENT'
    await writeQuote(deps, [putItem(deps.tables.quote, row)], 'offer')

    const link = quoteLinkFor(deps, token)
    const email = renderOfferRequestEmail({
      quote: quoteRecordOf(row),
      link,
      brokerName,
      template: optionalString(settings?.offerRequestEmailTemplate, 8000),
      bookNowRateCents: showBookNow ? bookNowRateCents : null,
      nowIso: now,
    })

    // `deliverNotice` claims the row, sends, and records what SES did — including
    // the dev NOT_SENT — so an offer request is never lost and never throws, and
    // the shipment's notice log shows what every carrier was asked.
    const sent = (await deliverNotice({
      db: deps.db,
      ses: deps.ses,
      tableName: deps.tables.shipmentNotice,
      from: deps.fromAddress,
      draft: {
        id: `cof:${id}`,
        shipmentId: leg.shipmentId,
        loadId,
        kind: 'CARRIER_OFFER',
        channel: via,
        to,
        subject: email.subject,
        body: email.body,
        createdBy: caller.email,
      },
    })).status === 'SENT'
    if (sent) {
      await deps.db.send(new UpdateItemCommand(quoteUpdateSpec(deps.tables.quote, id, { lastSendStatus: 'SENT' })))
      row.lastSendStatus = 'SENT'
    }

    offers.push(row)
    sends.push({ quoteId: id, link: link || null, sent, subject: email.subject, body: email.body, to })
  }

  await deps.writeAudit('LOAD', loadId, 'REQUEST_OFFERS', caller, {
    groupId, carrierIds, expiresAt, bookNowRateCents,
  })
  return { offers, sends, groupId } as unknown as Row
}

// ── LOG_OFFER ────────────────────────────────────────────────────────────────

/**
 * A price a carrier gave us on the phone. It lands QUOTED — the carrier has named
 * their number — with no token at all: nobody is waiting on a link, because the
 * conversation already happened.
 */
export async function logOffer(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const carrierId = assertString(input.carrierId, 'carrierId')
  const amountCents = optionalInteger(input.amountCents, { min: 0, label: 'amountCents' })
  if (amountCents == null) throw new Error('amountCents is required')

  const leg = await requestableLoad(deps, loadId)
  const carrier = await deps.getById(deps.tables.carrier, carrierId)
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)

  const settings = await deps.getSettings()
  const now = nowIso()
  const id = await nextQuoteNumber(deps, caller, now.slice(0, 10))
  const row = offerRow({
    id,
    groupId: optionalString(input.groupId, 100),
    leg,
    carrier,
    carrierEmail: optionalString(input.carrierEmail, 200) ?? optionalString(carrier.dispatcherEmail, 200),
    amountCents,
    bookNowRateCents: null,
    status: 'QUOTED',
    // No link, so no clock: the sentinel is what keeps the row in the open board's
    // composite index, and the sweep's `expiresAt < now` can never match it.
    expiresAt: NO_EXPIRY_SENTINEL,
    caller,
    now,
    message: optionalString(input.note, MAX_MESSAGE),
    event: 'LOGGED',
    aliases: aliasMap(settings?.postalCodeAliases as Parameters<typeof aliasMap>[0]),
  })
  row.contactName = optionalString(input.contactName, 120)
  row.acceptedVia = 'PHONE'
  await writeQuote(deps, [putItem(deps.tables.quote, row)], 'offer')
  await deps.writeAudit('QUOTE', id, 'LOG_OFFER', caller, { loadId, carrierId, amountCents })
  return { quote: row } as unknown as Row
}

// ── COUNTER_OFFER ────────────────────────────────────────────────────────────

/** Our number back at the carrier: a new token, one more round, same thread. */
export async function counterOffer(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const amountCents = optionalInteger(input.amountCents, { min: 0, label: 'amountCents' })
  if (amountCents == null) throw new Error('amountCents is required')
  const via = optionalEnum(input.via, SEND_CHANNELS, 'via') ?? 'EMAIL'
  const message = optionalString(input.message, MAX_MESSAGE)

  const quote = await loadQuote(deps, quoteId)
  if (quote.side !== 'BUY') throw new Error('Use COUNTER_QUOTE to counter a customer')
  const status = String(quote.status ?? '') as QuoteStatus
  if (!COUNTERABLE_STATUSES.includes(status)) {
    throw new Error(`A ${status} offer has nothing to counter`)
  }

  const settings = await deps.getSettings()
  const now = nowIso()
  const token = newLinkToken(deps.randomBytes)
  const expiresAt = quoteExpiry('BUY', now, null, quoteSettingsOf(settings), optionalString(quote.pickupAppt, 60))
  const to = optionalString(quote.carrierEmail, 200)
  const patch: Row = {
    status: 'SENT_COUNTER',
    quoteOpen: 'OPEN',
    // Our number is the counter; `amountCents` stays the carrier's, which is what
    // `ourOfferCents`, `numberOnTheTable` and `carrierLastNumber` all read it as.
    // Writing ours over theirs loses the counter and buys the load at their ask.
    counterCents: amountCents,
    counterBy: 'US',
    rounds: (numberOrNull(quote.rounds) ?? 0) + 1,
    linkToken: token,
    linkVersion: (numberOrNull(quote.linkVersion) ?? 0) + 1,
    requestCount: 0,
    expiresAt,
    sentAt: now,
    sentTo: to,
    sendCount: (numberOrNull(quote.sendCount) ?? 0) + 1,
    lastSendStatus: 'NOT_SENT',
    response: null,
    respondedAt: null,
    customerMessage: message ?? optionalString(quote.customerMessage, MAX_MESSAGE),
    events: pushEvent(quote, { at: now, by: caller.email, kind: 'COUNTERED', amountCents, note: message }),
    ...stamp(quote, caller, now),
  }
  await writeQuote(
    deps,
    [quoteUpdateTx(deps.tables.quote, quoteId, patch, {
      expectedVersion: expectedVersionOf(input),
      statusIn: COUNTERABLE_STATUSES,
    })],
    'offer',
  )

  const saved = await loadQuote(deps, quoteId)
  const link = quoteLinkFor(deps, token)
  const email = renderOfferRequestEmail({
    quote: quoteRecordOf(saved),
    link,
    brokerName: await brokerNameFor(deps, optionalString(quote.divisionKey, 100)),
    template: optionalString(settings?.offerRequestEmailTemplate, 8000),
    bookNowRateCents: null,
    nowIso: now,
  })
  const outcome = await trySend(deps, { to: to ? [to] : [], cc: [], via, link, ...email })
  if (outcome.sent) {
    await deps.db.send(new UpdateItemCommand(quoteUpdateSpec(deps.tables.quote, quoteId, { lastSendStatus: 'SENT' })))
  }

  await deps.writeAudit('QUOTE', quoteId, 'COUNTER_OFFER', caller, { amountCents, sent: outcome.sent })
  return {
    quote: { ...saved, ...(outcome.sent ? { lastSendStatus: 'SENT' } : {}) },
    link: outcome.link || null,
    sent: outcome.sent,
    subject: outcome.subject,
    body: outcome.body,
  } as unknown as Row
}

// ── REJECT_OFFER ─────────────────────────────────────────────────────────────

/** We are not taking this truck. LOST, with the reason the next person will read. */
export async function rejectOffer(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const quote = await loadQuote(deps, quoteId)
  if (quote.side !== 'BUY') throw new Error('Use MARK_QUOTE_LOST on a customer quote')
  const status = String(quote.status ?? '') as QuoteStatus
  if (!isOpenQuoteStatus(status)) throw new Error(`That offer is already ${status}`)

  const reason = optionalEnum(input.reason, LOST_REASONS, 'reason') ?? 'WITHDRAWN'
  const note = optionalString(input.note, 1000)
  const now = nowIso()
  await writeQuote(
    deps,
    [quoteUpdateTx(deps.tables.quote, quoteId, {
      status: 'LOST',
      lostReason: reason,
      lostNote: note,
      closedAt: now,
      events: pushEvent(quote, { at: now, by: caller.email, kind: 'REJECTED', note: note ?? reason }),
      ...stamp(quote, caller, now),
    }, {
      expectedVersion: expectedVersionOf(input),
      statusIn: OPEN_STATUSES,
      remove: ['quoteOpen', 'linkToken'],
    })],
    'offer',
  )
  await deps.writeAudit('QUOTE', quoteId, 'REJECT_OFFER', caller, { from: status, reason, note })
  return { quote: await loadQuote(deps, quoteId) } as unknown as Row
}

// ── ACCEPT_OFFER ─────────────────────────────────────────────────────────────

/**
 * Book the truck.
 *
 * This is `BOOK_CARRIER` and nothing less: the same eligibility gate, the same
 * insurance and double-booking refusals, the same acknowledged warnings — they come
 * back verbatim, because an offer is not a reason to book a carrier we would refuse.
 * The offer's own stamp rides in the booking transaction, so WON, `LoadCarrier.
 * quoteId` and the losing siblings all land with the assignment or not at all.
 */
export async function acceptOffer(deps: QuoteDeps, input: Row, caller: Caller): Promise<Row> {
  const quoteId = assertString(input.quoteId, 'quoteId')
  const quote = await loadQuote(deps, quoteId)
  if (quote.side !== 'BUY') throw new Error('Use CONVERT_QUOTE on a customer quote')
  const status = String(quote.status ?? '') as QuoteStatus
  if (!BOOKABLE_STATUSES.includes(status)) {
    throw new Error(`A ${status} offer cannot be booked`)
  }
  // The number the load is actually bought at: the carrier's own last one — their
  // counter when they made one, else the row's number, which on every other
  // bookable rung is their ask or the rate they took on the link. A dispatcher may
  // name it instead, and on SENT_COUNTER that is the only way: we are waiting on
  // the carrier there, so nothing on the row has been agreed by anybody.
  const named = optionalInteger(input.carrierRateCents, { min: 0, label: 'carrierRateCents' })
  if (status === 'SENT_COUNTER' && named == null) {
    throw new Error(
      'That carrier has not answered our counter — book it with the rate you agreed, or wait for their reply',
    )
  }
  const theirCounter = quote.counterBy === 'THEM' ? numberOrNull(quote.counterCents) : null
  const amountCents = named ?? theirCounter ?? numberOrNull(quote.amountCents) ?? 0
  if (amountCents <= 0) throw new Error('That offer carries no rate — log the carrier\'s number first')
  const loadId = optionalString(quote.loadId, 100)
  const carrierId = optionalString(quote.carrierId, 100)
  if (!loadId || !carrierId) throw new Error('That offer is not attached to a load and a carrier')

  const group = optionalString(quote.groupId, 100)
  const siblings = group
    ? (await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_LOAD, 'loadId', loadId))
        .filter((row) => optionalString(row.groupId, 100) === group)
    : []
  const now = nowIso()
  const writes: TransactWriteItem[] = [
    quoteUpdateTx(deps.tables.quote, quoteId, {
      status: 'WON',
      wonAt: now,
      closedAt: now,
      // The row records what was bought, not what was asked.
      amountCents,
      acceptedVia: optionalString(quote.acceptedVia, 20) ?? 'PHONE',
      events: pushEvent(quote, { at: now, by: caller.email, kind: 'WON', amountCents }),
      ...stamp(quote, caller, now),
    }, {
      expectedVersion: expectedVersionOf(input),
      statusIn: BOOKABLE_STATUSES,
      remove: ['quoteOpen', 'linkToken'],
    }),
    ...siblingCloseWrites(deps, siblings, quoteId, caller, now),
  ]

  // The gate's own input, with the two fields the offer decides: who, and for how
  // much. Everything else — equipment, dispatcher, tracking, quick pay — is the
  // dispatcher's, exactly as it is on a plain booking.
  const bundle = await deps.bookCarrier(
    { ...input, loadId, carrierId, carrierRateCents: amountCents },
    caller,
    { writes, loadCarrierFields: { quoteId } },
  )

  await deps.writeAudit('QUOTE', quoteId, 'ACCEPT_OFFER', caller, { loadId, carrierId, amountCents })
  return { quote: await loadQuote(deps, quoteId), bundle } as unknown as Row
}

// ── Covering a load closes its offers ────────────────────────────────────────

/**
 * A covered load never shows a live request.
 *
 * Called after a booking, a named assignment or an own-asset dispatch: every offer
 * still open on that leg is canceled, each under its own condition so a row that
 * closed a moment ago is skipped rather than fought over. Best effort by design —
 * the truck is on the load, and a stale request is not worth failing that over.
 */
export async function cancelOpenOffers(deps: QuoteDeps, loadId: string, caller: Caller): Promise<number> {
  if (!deps.tables.quote) return 0
  let canceled = 0
  try {
    const rows = await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_LOAD, 'loadId', loadId)
    const now = nowIso()
    for (const row of rows) {
      if (row.side !== 'BUY' || !isOpenQuoteStatus(String(row.status ?? '') as QuoteStatus)) continue
      try {
        await deps.db.send(
          new UpdateItemCommand(
            quoteUpdateSpec(deps.tables.quote, String(row.id), {
              status: 'CANCELED',
              closedAt: now,
              events: pushEvent(row, { at: now, by: caller.email, kind: 'CANCELED', note: 'Load covered' }),
              updatedBy: caller.email,
              updatedAt: now,
              version: (numberOrNull(row.version) ?? 1) + 1,
            }, { statusIn: OPEN_STATUSES, remove: ['quoteOpen', 'linkToken'] }),
          ),
        )
        canceled += 1
      } catch (err) {
        if (!isConflict(err)) throw err
      }
    }
  } catch (err) {
    console.warn('[tms-shipment-actions] open offer cancel failed:', String(err))
  }
  return canceled
}
