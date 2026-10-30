/**
 * Carrier offers — the buy-side answers that come back from postings, e-mail and
 * phone calls.
 *
 * A carrier answer is just a BUY Quote with posting/phone provenance. It never
 * books the carrier: accepting it later runs the ordinary booking gate with every
 * refusal and warning intact. That is the whole point of reusing Step H.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import type { Stop } from '../../../src/types'
import type { AdapterResult } from '../../../src/lib/integrations/types'
import { normalizeName } from '../../../src/lib/tmsDirectory'
import { laneKeyFor, laneKey3For } from '../../../src/lib/laneKey'
import {
  type Row,
  putItem,
  updateItemTx,
  monthOf,
  numberOrNull,
  readStops,
  IDX_LOADS_BY_SHIPMENT,
} from '../_shared/shipmentStore'
import {
  assertString,
  assertEnum,
  optionalString,
  optionalInteger,
  optionalIso,
  type Caller,
} from '../_shared/actionInputs'
import { NO_EXPIRY_SENTINEL, IDX_QUOTES_BY_LOAD } from './quotes'

const OFFER_SOURCES = ['EMAIL', 'PHONE', 'BOARD', 'MANUAL'] as const
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000
const IDX_CARRIERS_BY_MC = 'carriersByMcNumber'
const IDX_CARRIERS_BY_NAME = 'carriersByNormalizedName'

export interface CarrierOfferVetting {
  known: boolean
  bookable: boolean
  blockers: string[]
  warnings: string[]
  status: string
  mcpStatus: string | null
}

export interface CarrierOfferDeps {
  tables: {
    quote: string
    carrier: string
    carrierDocument: string
    shipment: string
    /** Offers hang off the leg, so the lane and the coverage state are read from it. */
    load: string
    posting: string
    settings: string
  }
  getById(tableName: string, id: string): Promise<Row | null>
  queryIndex(tableName: string, indexName: string, keyName: string, keyValue: unknown): Promise<Row[]>
  transact(items: TransactWriteItem[]): Promise<void>
  getSettings(): Promise<Row>
  writeAudit(entityType: string, entityId: string, action: string, caller: Caller, detail: Row): Promise<void>
  /** The existing booking gate's own answer for a carrier. Injected so there is one rule. */
  carrierStanding(carrier: Row | null, settings: Row): CarrierOfferVetting
  /** Step J MyCarrierPackets adapter — stub until credentials exist. */
  setupPacketAdapter(): Promise<{ mode: 'STUB' | 'LIVE'; send(input: Record<string, unknown>): Promise<AdapterResult> }>
  nextQuoteNumber(): Promise<string>
  now(): string
}

// ── Carrier lookup ───────────────────────────────────────────────────────────

async function findCarrier(deps: CarrierOfferDeps, input: Row): Promise<Row | null> {
  const mc = optionalString(input.carrierMc, 40)
  if (mc) {
    const byMc = await deps.queryIndex(deps.tables.carrier, IDX_CARRIERS_BY_MC, 'mcNumber', mc)
    if (byMc[0]) return byMc[0]
  }
  const rawName = optionalString(input.carrierName, 200)
  if (!rawName) return null
  const key = normalizeName(rawName)
  if (!key) return null
  const byName = await deps.queryIndex(deps.tables.carrier, IDX_CARRIERS_BY_NAME, 'normalizedName', key)
  return byName[0] ?? null
}

// ── Duplicate detection ──────────────────────────────────────────────────────

function isDuplicate(
  input: Row,
  carrierId: string | null,
  amountCents: number,
  existing: Row,
  now: string,
): boolean {
  if (String(existing.side ?? '') !== 'BUY') return false
  if (numberOrNull(existing.amountCents) !== amountCents) return false

  const existingCarrierId = existing.carrierId ? String(existing.carrierId) : null
  const inputMc = String(input.carrierMc ?? '')
  const existingMc = String(existing.carrierMc ?? '')
  const identityMatch =
    (carrierId && existingCarrierId && existingCarrierId === carrierId) ||
    (inputMc && existingMc && inputMc === existingMc)
  if (!identityMatch) return false

  const created = String(existing.createdAt ?? '1970-01-01T00:00:00.000Z')
  return new Date(now).getTime() - new Date(created).getTime() <= DUPLICATE_WINDOW_MS
}

// ── RECORD_CARRIER_OFFER ─────────────────────────────────────────────────────

/**
 * Turn a carrier answer into a BUY Quote on the shipment.
 *
 * The carrier is matched by MC (preferred) or normalized name. An unknown MC is
 * not a refusal — the row records with `carrierId: null` so dispatch can send a
 * setup packet. A duplicate MC/rate within ten minutes returns the first row,
 * which keeps a re-delivered e-mail from creating multiple offers.
 */
export async function recordCarrierOffer(deps: CarrierOfferDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const carrierName = assertString(input.carrierName, 'carrierName')
  const amountCents = optionalInteger(input.amountCents, { label: 'amountCents' })
  if (amountCents == null) throw new Error('amountCents is required')
  if (amountCents <= 0) throw new Error('amountCents must be greater than zero')
  const source = assertEnum(input.source, OFFER_SOURCES, 'source')

  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (shipment.voidedAt) throw new Error('That shipment is voided')

  const loads = await deps.queryIndex(deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  if (loads.length === 0) throw new Error('That shipment has no load to offer')
  if (loads.some((load) => load.activeLoadCarrierId != null)) throw new Error('That load is already covered')

  const load = loads[0]!
  const loadId = String(load.id)

  const carrier = await findCarrier(deps, input)
  const carrierId = carrier ? String(carrier.id) : null

  const settings = await deps.getSettings()
  const now = deps.now()

  const existingOffers = await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_LOAD, 'loadId', loadId)
  const duplicate = existingOffers.find((row) => isDuplicate(input, carrierId, amountCents, row, now))
  if (duplicate) {
    return {
      quote: duplicate,
      carrierId,
      vetting: deps.carrierStanding(carrier, settings),
    }
  }

  const quoteId = await deps.nextQuoteNumber()
  const quoteDate = now.slice(0, 10)
  const stops = readStops(load) as unknown as Stop[]
  const pickupAppt = optionalString(load.pickupAppt, 60)
  const row: Row = {
    id: quoteId,
    __typename: 'Quote',
    side: 'BUY',
    status: 'RECEIVED_REPLY',
    quoteOpen: 'OPEN',
    quoteDate,
    quoteMonth: monthOf(quoteDate) ?? quoteDate.slice(0, 7),
    carrierId,
    carrierName,
    carrierMc: optionalString(input.carrierMc, 40),
    carrierEmail: optionalString(input.carrierEmail, 200),
    shipmentId,
    loadId,
    loadNumber: optionalString(load.loadNumber, 60),
    divisionKey: optionalString(load.divisionKey, 100),
    equipmentType: optionalString(input.equipmentType, 80) ?? optionalString(load.equipmentType, 80),
    stops,
    laneKey: laneKeyFor(stops, null),
    laneKey3: laneKey3For(stops),
    pickupAppt,
    deliveryAppt: optionalString(load.deliveryAppt, 60),
    commodity: optionalString(load.commodity, 200),
    weightLbs: numberOrNull(load.weight),
    miles: numberOrNull(load.miles),
    amountCents,
    rounds: 0,
    expiresAt: NO_EXPIRY_SENTINEL,
    offerSource: source,
    offerContactName: optionalString(input.contactName, 120),
    offerContactPhone: optionalString(input.contactPhone, 40),
    offerAvailableAt: optionalIso(input.availableAt, 'availableAt'),
    offerPostingId: optionalString(input.postingId, 120),
    offerMessageRef: optionalString(input.messageRef, 120),
    customerMessage: optionalString(input.notes, 4000),
    events: [{ at: now, by: caller.email, kind: 'RECEIVED_REPLY', amountCents }],
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  const shipmentUpdatedAt = String(shipment.updatedAt ?? '')
  if (!shipmentUpdatedAt) throw new Error('Shipment is missing updatedAt')
  const tx: TransactWriteItem[] = [
    putItem(deps.tables.quote, row),
    updateItemTx(
      deps.tables.shipment,
      shipmentId,
      {
        carrierOfferOpen: 'OPEN',
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(shipment.version) ?? 0) + 1,
      },
      shipmentUpdatedAt,
    ),
  ]

  const postingId = optionalString(input.postingId, 120)
  if (postingId) {
    const posting = await deps.getById(deps.tables.posting, postingId)
    if (!posting) throw new Error(`Posting not found: ${postingId}`)
    const postingUpdatedAt = String(posting.updatedAt ?? '')
    if (!postingUpdatedAt) throw new Error('Posting is missing updatedAt')
    tx.push(
      updateItemTx(
        deps.tables.posting,
        postingId,
        {
          offerCount: (numberOrNull(posting.offerCount) ?? 0) + 1,
          updatedBy: caller.email,
          updatedAt: now,
          version: (numberOrNull(posting.version) ?? 0) + 1,
        },
        postingUpdatedAt,
      ),
    )
  }

  await deps.transact(tx)
  await deps.writeAudit('QUOTE', quoteId, 'RECORD_CARRIER_OFFER', caller, {
    shipmentId,
    loadId,
    carrierId,
    carrierName,
    amountCents,
    source,
  })

  return {
    quote: row,
    carrierId,
    vetting: deps.carrierStanding(carrier, settings),
  }
}

// ── LIST_CARRIER_OFFERS ──────────────────────────────────────────────────────

/**
 * Every BUY quote on a shipment, with the booking gate's current verdict attached.
 * Open offers first, then cheapest first, so dispatch sees what it can act on.
 */
export async function listCarrierOffers(deps: CarrierOfferDeps, input: Row): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const settings = await deps.getSettings()
  const loads = await deps.queryIndex(deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const offers: Row[] = []
  for (const load of loads) {
    const rows = await deps.queryIndex(deps.tables.quote, IDX_QUOTES_BY_LOAD, 'loadId', String(load.id))
    offers.push(...rows.filter((row) => String(row.side ?? '') === 'BUY'))
  }
  offers.sort((a, b) => {
    const aOpen = String(a.quoteOpen ?? '') === 'OPEN' ? 0 : 1
    const bOpen = String(b.quoteOpen ?? '') === 'OPEN' ? 0 : 1
    if (aOpen !== bOpen) return aOpen - bOpen
    return (numberOrNull(a.amountCents) ?? 0) - (numberOrNull(b.amountCents) ?? 0)
  })

  const enriched = await Promise.all(
    offers.map(async (quote) => {
      const carrier = quote.carrierId ? await deps.getById(deps.tables.carrier, String(quote.carrierId)) : null
      return { ...quote, vetting: deps.carrierStanding(carrier, settings) }
    }),
  )

  return { offers: enriched }
}

// ── SEND_SETUP_PACKET ────────────────────────────────────────────────────────

/**
 * Send a MyCarrierPackets setup packet for an offer whose carrier is not known or
 * not yet bookable. Vetted, bookable carriers are refused — they are already set up.
 */
export async function sendSetupPacket(deps: CarrierOfferDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const quoteId = assertString(input.quoteId, 'quoteId')
  const email = assertString(input.email, 'email')

  const quote = await deps.getById(deps.tables.quote, quoteId)
  if (!quote) throw new Error(`Offer not found: ${quoteId}`)
  if (String(quote.shipmentId ?? '') !== shipmentId) throw new Error('That offer belongs to a different shipment')

  const carrier = quote.carrierId ? await deps.getById(deps.tables.carrier, String(quote.carrierId)) : null
  const settings = await deps.getSettings()
  const standing = deps.carrierStanding(carrier, settings)
  const name = optionalString(quote.carrierName, 200) ?? optionalString(carrier?.name, 200) ?? 'That carrier'
  if (standing.bookable) {
    throw new Error(`${name} is already set up`)
  }

  const adapter = await deps.setupPacketAdapter()
  const result = await adapter.send({
    email,
    carrierName: quote.carrierName,
    carrierMc: quote.carrierMc,
    shipmentId,
    quoteId,
  })

  await deps.writeAudit('QUOTE', quoteId, 'SEND_SETUP_PACKET', caller, {
    shipmentId,
    email,
    mode: result.mode,
    ok: result.ok,
    message: result.message,
  })

  return { sent: result.ok, mode: result.mode, message: result.message }
}

/**
 * Send a MyCarrierPackets setup packet to a carrier from their profile. The carrier
 * must exist in the directory; email is the one the packet is addressed to.
 */
export async function sendCarrierSetupPacket(deps: CarrierOfferDeps, input: Row, caller: Caller): Promise<Row> {
  const carrierId = assertString(input.carrierId, 'carrierId')
  const email = assertString(input.email, 'email')

  const carrier = await deps.getById(deps.tables.carrier, carrierId)
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)

  const adapter = await deps.setupPacketAdapter()
  const result = await adapter.send({
    email,
    carrierName: carrier.name,
    carrierMc: carrier.mcNumber,
  })

  await deps.writeAudit('CARRIER', carrierId, 'SEND_CARRIER_SETUP_PACKET', caller, {
    email,
    mode: result.mode,
    ok: result.ok,
    message: result.message,
  })

  return { sent: result.ok, mode: result.mode, message: result.message }
}
