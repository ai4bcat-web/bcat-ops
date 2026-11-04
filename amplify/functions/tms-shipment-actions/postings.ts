/**
 * Step P6 — post a shipment to DAT and Truckstop, unpost it, and list where it has
 * been offered. The row id is deterministic (`post:<shipmentId>:<PROVIDER>`), so a
 * re-post updates one row instead of growing duplicates, and unposting is a status
 * change, never a delete.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import {
  numberOrNull,
  readStops,
  updateItemTx,
  type Bundle,
  type Row,
} from '../_shared/shipmentStore'
import {
  assertArrayOf,
  assertString,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import { isVoided } from '../_shared/voided'
import { requiredFieldLabel } from '../../../src/lib/flowDefaults'

/**
 * The shape of the shipment bundle this module reads. The store already owns this
 * type; re-exporting it under the task's name keeps the wiring contract short.
 */
export type ShipmentBundleish = Bundle

/** What a provider board adapter answers when asked to post or unpost a load. */
export interface AdapterAnswer {
  mode: 'STUB' | 'LIVE'
  ok: boolean
  message: string
  externalId?: string
  detail?: Record<string, unknown>
}

/** The injected dependencies the lead's handler wires for this module. */
export interface PostingDeps {
  tables: {
    posting: string
    shipment: string
    load: string
    order: string
    integration: string
    /** Step AE: only the quote / spot-request posting actions read it. */
    quote?: string
  }
  getById(table: string, id: string): Promise<Row | null>
  queryIndex(table: string, index: string, key: string, value: string): Promise<Row[]>
  transact(items: TransactWriteItem[]): Promise<void>
  /** `readBundle` already performs the get-by-id; a missing shipment throws from there. */
  readBundle(shipmentId: string): Promise<ShipmentBundleish>
  writeAudit(
    entityType: string,
    entityId: string,
    action: string,
    caller: Caller,
    changes: Row,
  ): Promise<void>
  /**
   * Step J returns the right adapter per provider. This module does not decide
   * stub-vs-live; it only writes down what the adapter answered.
   */
  adapterFor(provider: string): Promise<{
    mode: 'STUB' | 'LIVE'
    post(input: Record<string, unknown>): Promise<AdapterAnswer>
    unpost(input: Record<string, unknown>): Promise<AdapterAnswer>
  }>
  now(): string
}

export const POSTABLE_PROVIDERS: readonly string[] = ['DAT', 'TRUCKSTOP']
export const IDX_POSTINGS_BY_SHIPMENT = 'shipmentPostingsByShipmentId'
export const IDX_POSTINGS_BY_STATUS = 'shipmentPostingsByStatusAndPostedAt'

/** Deterministic posting row id: one row per shipment per board. */
function postingId(shipmentId: string, provider: string): string {
  return `post:${shipmentId}:${provider}`
}

function assertProviders(value: unknown): string[] {
  const providers = assertArrayOf(value, 'providers', (v, i) => assertString(v, `providers[${i}]`), 10)
  if (providers.length === 0) throw new Error('providers must have at least one entry')
  return [...new Set(providers)]
}

interface LaneSnapshot {
  loadId: string | null
  originCity: string | null
  originState: string | null
  destinationCity: string | null
  destinationState: string | null
  pickupAppt: string | null
  equipmentType: string | null
  lengthFt: number | null
  weightLbs: number | null
  rateCents: number | null
}

/** Snapshot the lane the board will see: first pickup → last delivery. */
function laneSnapshot(bundle: Bundle, loadIdInput: string | undefined, rateCentsInput: number | null): LaneSnapshot {
  const loads = [...bundle.loads].sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  const targetLoad =
    (loadIdInput ? loads.find((l) => String(l.id) === loadIdInput) : undefined) ??
    loads[0] ??
    null

  const stops = loads.flatMap((l) => readStops(l))
  const pickups = stops.filter((s) => s.type === 'pickup' && s.appt)
  const deliveries = stops.filter((s) => s.type === 'delivery' && s.appt)
  pickups.sort((a, b) => String(a.appt).localeCompare(String(b.appt)))
  deliveries.sort((a, b) => String(a.appt).localeCompare(String(b.appt)))

  const firstPickup = pickups[0] ?? stops.find((s) => s.type === 'pickup') ?? null
  const lastDelivery =
    deliveries[deliveries.length - 1] ??
    stops.filter((s) => s.type === 'delivery').pop() ??
    null

  return {
    loadId: targetLoad ? String(targetLoad.id) : null,
    originCity: firstPickup?.city ?? ((firstPickup?.address as { city?: string | null } | null)?.city ?? null),
    originState: firstPickup?.state != null ? String(firstPickup.state) : ((firstPickup?.address as { state?: string | null } | null)?.state ?? null),
    destinationCity: lastDelivery?.city ?? ((lastDelivery?.address as { city?: string | null } | null)?.city ?? null),
    destinationState: lastDelivery?.state != null ? String(lastDelivery.state) : ((lastDelivery?.address as { state?: string | null } | null)?.state ?? null),
    pickupAppt: firstPickup?.appt ?? null,
    equipmentType: targetLoad?.equipmentType ? String(targetLoad.equipmentType) : null,
    lengthFt: numberOrNull(targetLoad?.lengthFt),
    weightLbs: numberOrNull(targetLoad?.weight),
    rateCents: rateCentsInput ?? numberOrNull(targetLoad?.rate),
  }
}

function finalPostedBoards(postings: Row[]): string[] {
  return postings
    .filter((p) => p.status === 'POSTED')
    .map((p) => String(p.provider))
    .sort()
}

/**
 * POST_LOAD — offer the shipment to one or more boards.
 *
 * Refuses voided, still-building, or already-covered loads before any adapter is
 * called. Each provider gets its own adapter call; a failed call writes a FAILED
 * row and does not abort the others. The Shipment mirror is updated in the same
 * transaction.
 */
export async function postLoad(deps: PostingDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const loadIdInput = optionalString(input.loadId) ?? undefined
  const providers = assertProviders(input.providers)
  const rateCentsInput = optionalInteger(input.rateCents, { label: 'rateCents', min: 0 })
  const note = optionalString(input.note)
  const contactEmail = optionalString(input.contactEmail)
  const contactPhone = optionalString(input.contactPhone)

  const bundle = await deps.readBundle(shipmentId)
  const { shipment, loads, loadCarriers } = bundle

  if (isVoided(shipment)) throw new Error('A voided shipment cannot be posted')
  if (shipment.buildState === 'BUILDING') {
    const missing = Array.isArray(shipment.missingFields) ? shipment.missingFields : []
    throw new Error(
      `Finish building this shipment first — it still needs: ${missing.map(requiredFieldLabel).join(', ')}`,
    )
  }

  const active = loadCarriers.find(
    (c) => c.status === 'ACTIVE' && loads.some((l) => String(l.id) === String(c.loadId)),
  )
  if (active) {
    const name = active.carrierName || active.carrierMc || 'this carrier'
    throw new Error(`That load is already covered by ${name}`)
  }

  for (const provider of providers) {
    if (!POSTABLE_PROVIDERS.includes(provider)) {
      throw new Error(
        `${provider} is not a postable provider. Choose one of: ${POSTABLE_PROVIDERS.join(', ')}`,
      )
    }
  }

  const existing = await deps.queryIndex(deps.tables.posting, IDX_POSTINGS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const existingById: Record<string, Row> = {}
  for (const p of existing) existingById[String(p.id)] = p

  const snapshot = laneSnapshot(bundle, loadIdInput, rateCentsInput)
  const now = deps.now()

  const txItems: TransactWriteItem[] = []
  const postingRows: Row[] = []

  for (const provider of providers) {
    const adapter = await deps.adapterFor(provider)
    let answer: AdapterAnswer
    try {
      answer = await adapter.post({
        provider,
        shipmentId,
        ...snapshot,
        contactEmail,
        contactPhone,
        note,
      })
    } catch (err) {
      answer = { mode: 'STUB', ok: false, message: String(err) }
    }

    const id = postingId(shipmentId, provider)
    const prior = existingById[id]
    const status = answer.ok ? 'POSTED' : 'FAILED'
    const row: Row = {
      id,
      __typename: 'ShipmentPosting',
      shipmentId,
      loadId: snapshot.loadId,
      provider,
      status,
      mode: answer.mode,
      boardPostingId: answer.externalId ?? null,
      message: answer.message,
      originCity: snapshot.originCity,
      originState: snapshot.originState,
      destinationCity: snapshot.destinationCity,
      destinationState: snapshot.destinationState,
      pickupAppt: snapshot.pickupAppt,
      equipmentType: snapshot.equipmentType,
      lengthFt: snapshot.lengthFt,
      weightLbs: snapshot.weightLbs,
      rateCents: snapshot.rateCents,
      contactEmail,
      contactPhone,
      note,
      ...(status === 'POSTED'
        ? { postedAt: now, postedBy: caller.email }
        : prior?.postedAt
          ? { postedAt: prior.postedAt, postedBy: prior.postedBy }
          : {}),
      createdBy: prior?.createdBy ?? caller.email,
      createdAt: prior?.createdAt ?? now,
      updatedBy: caller.email,
      updatedAt: now,
      version: (typeof prior?.version === 'number' ? prior.version : 0) + 1,
    }
    const patch: Row = { ...row }
    delete patch.id
    postingRows.push(row)
    existingById[id] = row
    txItems.push(updateItemTx(deps.tables.posting, id, patch, null, { remove: ['unpostedAt', 'unpostedBy'] }))
    await deps.writeAudit('SHIPMENT_POSTING', id, 'POST_LOAD', caller, {
      provider,
      status,
      mode: answer.mode,
      boardPostingId: answer.externalId ?? null,
    })
  }

  const postedBoards = finalPostedBoards(Object.values(existingById))
  const shipmentPatch: Row = {
    postedBoards,
    updatedAt: now,
    updatedBy: caller.email,
  }
  if (postedBoards.includes('DAT') && !shipment.datPostedAt) {
    shipmentPatch.datPostedAt = now
  }
  const expectedUpdatedAt =
    optionalString(input.expectedUpdatedAt) ?? String(shipment.updatedAt ?? '')
  txItems.push(updateItemTx(deps.tables.shipment, shipmentId, shipmentPatch, expectedUpdatedAt))

  await deps.transact(txItems)
  const updatedShipment = await deps.getById(deps.tables.shipment, shipmentId)
  return { postings: postingRows, shipment: updatedShipment ?? shipmentPatch }
}

/**
 * UNPOST_LOAD — take the shipment down from one or more boards.
 *
 * Unposting never deletes the row; it flips status to UNPOSTED and keeps the lane
 * snapshot and board id so the Postings section can still report where the load
 * was offered. A provider that refuses the unpost keeps the row POSTED and records
 * the refusal message.
 */
export async function unpostLoad(deps: PostingDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const providers = assertProviders(input.providers)

  const bundle = await deps.readBundle(shipmentId)
  const { shipment } = bundle
  if (isVoided(shipment)) throw new Error('A voided shipment cannot be unposted')

  const existing = await deps.queryIndex(deps.tables.posting, IDX_POSTINGS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const existingById: Record<string, Row> = {}
  for (const p of existing) existingById[String(p.id)] = p
  const now = deps.now()

  const txItems: TransactWriteItem[] = []
  const postingRows: Row[] = []

  for (const provider of providers) {
    if (!POSTABLE_PROVIDERS.includes(provider)) {
      throw new Error(
        `${provider} is not a postable provider. Choose one of: ${POSTABLE_PROVIDERS.join(', ')}`,
      )
    }
    const id = postingId(shipmentId, provider)
    const prior = existingById[id]
    if (!prior) continue

    const adapter = await deps.adapterFor(provider)
    let answer: AdapterAnswer
    try {
      answer = await adapter.unpost({ provider, shipmentId, boardPostingId: prior.boardPostingId, ...prior })
    } catch (err) {
      answer = { mode: prior.mode === 'LIVE' || prior.mode === 'STUB' ? prior.mode : 'STUB', ok: false, message: String(err) }
    }

    const patch: Row = {
      message: answer.ok ? (answer.message ?? prior.message) : answer.message,
      updatedBy: caller.email,
      updatedAt: now,
      version: (typeof prior.version === 'number' ? prior.version : 0) + 1,
    }
    if (answer.ok) {
      patch.status = 'UNPOSTED'
      patch.unpostedAt = now
      patch.unpostedBy = caller.email
    }
    postingRows.push({ ...prior, ...patch })
    existingById[id] = { ...prior, ...patch }
    txItems.push(updateItemTx(deps.tables.posting, id, patch, null))
    await deps.writeAudit('SHIPMENT_POSTING', id, 'UNPOST_LOAD', caller, {
      provider,
      status: patch.status ?? prior.status,
      boardPostingId: prior.boardPostingId ?? null,
    })
  }

  const postedBoards = finalPostedBoards(Object.values(existingById))
  const shipmentPatch: Row = {
    postedBoards,
    updatedAt: now,
    updatedBy: caller.email,
  }
  const remove: string[] = []
  if (!postedBoards.includes('DAT')) {
    remove.push('datPostedAt')
  }
  const expectedUpdatedAt = String(shipment.updatedAt ?? '')
  txItems.push(updateItemTx(deps.tables.shipment, shipmentId, shipmentPatch, expectedUpdatedAt, remove.length ? { remove } : undefined))

  await deps.transact(txItems)
  const updatedShipment = await deps.getById(deps.tables.shipment, shipmentId)
  return { postings: postingRows, shipment: updatedShipment ?? shipmentPatch }
}

/** LIST_POSTINGS — every board this shipment has been offered on, newest first. */
export async function listPostings(deps: PostingDeps, input: Row): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const rows = await deps.queryIndex(deps.tables.posting, IDX_POSTINGS_BY_SHIPMENT, 'shipmentId', shipmentId)
  rows.sort((a, b) => {
    const byPosted = String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? ''))
    return byPosted || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  })
  return { postings: rows }
}

// ── Step AE: Push to DAT from a quote or a spot request ──────────────────────
//
// A load board posting is a statement about a lane at a price; it needs no shipment. A quote (or a
// spot request that has no quote yet) is posted through the SAME provider adapter and the SAME
// `ShipmentPosting` rows as POST_LOAD, with no schema change: the row's required `shipmentId` carries
// the subject key (`quote:<quoteId>` / `spot:<requestId>`), its deterministic id is
// `post:<key>:<PROVIDER>`, and the link to the other record rides in `note` as `[quote Q1 · spot sr:…]`.
// No Shipment row exists, so none is touched. Live when the provider's credentials exist, otherwise the
// adapter's labelled STUB answer is recorded exactly as for a shipment.

const DEFAULT_QUOTE_PROVIDERS = ['DAT']
const UNPOSTABLE_QUOTE_STATUS = ['LOST', 'PASS', 'CANCELED']

function quotePostingProviders(value: unknown): string[] {
  const providers = value == null ? DEFAULT_QUOTE_PROVIDERS : assertProviders(value)
  for (const provider of providers) {
    if (!POSTABLE_PROVIDERS.includes(provider)) {
      throw new Error(`${provider} is not a postable provider. Choose one of: ${POSTABLE_PROVIDERS.join(', ')}`)
    }
  }
  return providers
}

/** The posting subject key: the quote when there is one, else the spot request. */
export function quotePostingKey(input: Row): { key: string; quoteId: string | null; spotRequestId: string | null } {
  const quoteId = optionalString(input.quoteId, 80)
  const spotRequestId = optionalString(input.spotRequestId, 300)
  if (!quoteId && !spotRequestId) throw new Error('quoteId or spotRequestId is required')
  return { key: quoteId ? `quote:${quoteId}` : `spot:${spotRequestId}`, quoteId, spotRequestId }
}

function placeField(stop: Row | undefined, field: 'city' | 'state'): string | null {
  if (!stop) return null
  const address = (stop.address ?? null) as Row | null
  const direct = typeof stop[field] === 'string' && stop[field] ? String(stop[field]) : null
  const nested = address && typeof address[field] === 'string' && address[field] ? String(address[field]) : null
  if (field === 'state') return nested ?? direct
  return nested ?? (direct ? direct.split(',')[0].trim() : null)
}

/** POST_QUOTE_LOAD — offer a quote's (or a spot request's) lane to the load board. */
export async function postQuoteLoad(deps: PostingDeps, input: Row, caller: Caller): Promise<Row> {
  const { key, quoteId, spotRequestId } = quotePostingKey(input)
  const providers = quotePostingProviders(input.providers)
  const rateInput = optionalInteger(input.rateCents, { label: 'rateCents', min: 0 })
  const userNote = optionalString(input.note, 500)
  const contactEmail = optionalString(input.contactEmail, 200)
  const contactPhone = optionalString(input.contactPhone, 40)

  let snapshot: Omit<LaneSnapshot, 'loadId'>
  let linkedSpot = spotRequestId
  if (quoteId) {
    if (!deps.tables.quote) throw new Error('Quote table is not configured')
    const quote = await deps.getById(deps.tables.quote, quoteId)
    if (!quote) throw new Error(`Quote ${quoteId} not found`)
    if (quote.side !== 'SELL') throw new Error('Only a customer quote can be pushed to the board')
    if (UNPOSTABLE_QUOTE_STATUS.includes(String(quote.status))) throw new Error(`A ${String(quote.status).toLowerCase()} quote cannot be posted`)
    if (quote.shipmentId) throw new Error('This quote is already a shipment — post it from the shipment')
    const stops = readStops(quote)
    const pickup = stops.find((s) => s.type === 'pickup') ?? stops[0]
    const delivery = [...stops].reverse().find((s) => s.type === 'delivery') ?? (stops.length > 1 ? stops[stops.length - 1] : undefined)
    snapshot = {
      originCity: placeField(pickup, 'city'),
      originState: placeField(pickup, 'state'),
      destinationCity: placeField(delivery, 'city'),
      destinationState: placeField(delivery, 'state'),
      pickupAppt: typeof pickup?.appt === 'string' && pickup.appt ? pickup.appt : null,
      equipmentType: typeof quote.equipmentType === 'string' ? quote.equipmentType : null,
      lengthFt: numberOrNull(quote.equipmentLengthFt),
      weightLbs: numberOrNull(quote.weightLbs),
      // What we would pay a carrier: the rep's number, else the quote's own buy ceiling / target.
      rateCents: rateInput ?? numberOrNull(quote.topSpendCents) ?? numberOrNull(quote.targetBuyCents),
    }
    linkedSpot = linkedSpot ?? (typeof quote.spotRequestId === 'string' ? quote.spotRequestId : null)
  } else {
    const pickupDate = optionalString(input.pickupDate, 40)
    snapshot = {
      originCity: optionalString(input.originCity, 120),
      originState: optionalString(input.originState, 40),
      destinationCity: optionalString(input.destinationCity, 120),
      destinationState: optionalString(input.destinationState, 40),
      pickupAppt: pickupDate ? (pickupDate.length === 10 ? `${pickupDate}T12:00:00.000Z` : pickupDate) : null,
      equipmentType: optionalString(input.equipmentType, 60),
      lengthFt: optionalInteger(input.lengthFt, { label: 'lengthFt', min: 0 }),
      weightLbs: optionalInteger(input.weightLbs, { label: 'weightLbs', min: 0 }),
      rateCents: rateInput,
    }
  }
  if (!snapshot.originCity || !snapshot.originState || !snapshot.destinationCity || !snapshot.destinationState) {
    throw new Error('The load needs a pickup and a delivery city and state before it can be posted')
  }
  if (!snapshot.equipmentType) throw new Error('The load needs an equipment type before it can be posted')

  const note = [userNote, `[${[quoteId ? `quote ${quoteId}` : null, linkedSpot ? `spot ${linkedSpot}` : null].filter(Boolean).join(' · ')}]`]
    .filter(Boolean).join(' ')
  const existing = await deps.queryIndex(deps.tables.posting, IDX_POSTINGS_BY_SHIPMENT, 'shipmentId', key)
  const existingById: Record<string, Row> = {}
  for (const p of existing) existingById[String(p.id)] = p
  const now = deps.now()
  const txItems: TransactWriteItem[] = []
  const postingRows: Row[] = []

  for (const provider of providers) {
    const adapter = await deps.adapterFor(provider)
    let answer: AdapterAnswer
    try {
      answer = await adapter.post({ provider, shipmentId: key, loadId: null, ...snapshot, contactEmail, contactPhone, note })
    } catch (err) {
      answer = { mode: 'STUB', ok: false, message: String(err) }
    }
    const id = postingId(key, provider)
    const prior = existingById[id]
    const status = answer.ok ? 'POSTED' : 'FAILED'
    const row: Row = {
      id,
      __typename: 'ShipmentPosting',
      shipmentId: key,
      loadId: null,
      provider,
      status,
      mode: answer.mode,
      boardPostingId: answer.externalId ?? null,
      message: answer.message,
      ...snapshot,
      contactEmail,
      contactPhone,
      note,
      ...(status === 'POSTED'
        ? { postedAt: now, postedBy: caller.email }
        : prior?.postedAt ? { postedAt: prior.postedAt, postedBy: prior.postedBy } : {}),
      createdBy: prior?.createdBy ?? caller.email,
      createdAt: prior?.createdAt ?? now,
      updatedBy: caller.email,
      updatedAt: now,
      version: (typeof prior?.version === 'number' ? prior.version : 0) + 1,
    }
    const patch: Row = { ...row }
    delete patch.id
    postingRows.push(row)
    txItems.push(updateItemTx(deps.tables.posting, id, patch, null, { remove: ['unpostedAt', 'unpostedBy'] }))
    await deps.writeAudit('SHIPMENT_POSTING', id, 'POST_QUOTE_LOAD', caller, { provider, status, mode: answer.mode, subject: key })
  }
  await deps.transact(txItems)
  return { postings: postingRows }
}

/** UNPOST_QUOTE_LOAD — take a quote's / spot request's posting down. The row stays, flipped to UNPOSTED. */
export async function unpostQuoteLoad(deps: PostingDeps, input: Row, caller: Caller): Promise<Row> {
  const { key } = quotePostingKey(input)
  const providers = quotePostingProviders(input.providers)
  const existing = await deps.queryIndex(deps.tables.posting, IDX_POSTINGS_BY_SHIPMENT, 'shipmentId', key)
  const byId: Record<string, Row> = {}
  for (const p of existing) byId[String(p.id)] = p
  const now = deps.now()
  const txItems: TransactWriteItem[] = []
  const postingRows: Row[] = []

  for (const provider of providers) {
    const id = postingId(key, provider)
    const prior = byId[id]
    if (!prior) continue
    const adapter = await deps.adapterFor(provider)
    let answer: AdapterAnswer
    try {
      answer = await adapter.unpost({ provider, shipmentId: key, boardPostingId: prior.boardPostingId, ...prior })
    } catch (err) {
      answer = { mode: prior.mode === 'LIVE' ? 'LIVE' : 'STUB', ok: false, message: String(err) }
    }
    const patch: Row = {
      message: answer.message,
      updatedBy: caller.email,
      updatedAt: now,
      version: (typeof prior.version === 'number' ? prior.version : 0) + 1,
    }
    if (answer.ok) {
      patch.status = 'UNPOSTED'
      patch.unpostedAt = now
      patch.unpostedBy = caller.email
    }
    postingRows.push({ ...prior, ...patch })
    txItems.push(updateItemTx(deps.tables.posting, id, patch, null))
    await deps.writeAudit('SHIPMENT_POSTING', id, 'UNPOST_QUOTE_LOAD', caller, { provider, status: patch.status ?? prior.status, subject: key })
  }
  if (txItems.length) await deps.transact(txItems)
  return { postings: postingRows }
}
