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
