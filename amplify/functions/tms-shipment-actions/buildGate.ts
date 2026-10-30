/**
 * Step P5 — the required-fields gate, and what Building means.
 *
 * A shipment that steps out of K's TENDER proposal without every required field
 * lands in BUILDING. `completeBuild` recomputes the Needs list and flips it to
 * BUILT only when nothing is missing; every downstream action calls `assertBuilt`
 * before it does anything that needs the load to be real.
 *
 * Older shipments that have no `buildState` at all predate Step P and are treated
 * as already built, so the gate never retroactively traps freight a human shipped.
 */
import {
  assertExpectedUpdatedAt,
  assertString,
  type Caller,
} from '../_shared/actionInputs'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  readStops,
  updateItemTx,
  type Bundle,
  type Row,
} from '../_shared/shipmentStore'
import {
  missingRequiredFields,
  needsLine,
  requiredFieldLabel,
  resolveRequiredFields,
  type RequiredFieldSubject,
} from '../../../src/lib/flowDefaults'

export interface BuildGateDeps {
  tables: { shipment: string; order: string; load: string; customer: string; settings: string }
  getById(table: string, id: string): Promise<Row | null>
  queryIndex(table: string, index: string, key: string, value: string): Promise<Row[]>
  transact(items: TransactWriteItem[]): Promise<void>
  readBundle(shipmentId: string): Promise<Row>
  getSettings(): Promise<Row>
  writeAudit(
    entityType: string,
    entityId: string,
    action: string,
    caller: Caller,
    changes: Row,
  ): Promise<void>
  now(): string
}

function assertNotVoided(shipment: Row): void {
  if (shipment.voidedAt) {
    throw new Error(`Shipment ${String(shipment.number ?? shipment.id)} is voided`)
  }
}

function effectiveBuildState(shipment: Row): 'BUILDING' | 'BUILT' {
  const raw = shipment.buildState
  if (raw === 'BUILDING') return 'BUILDING'
  // No buildState means this shipment predates Step P; it was built by a person.
  return 'BUILT'
}

function buildRefusal(missing: readonly string[]): string {
  const labels = missing.map(requiredFieldLabel).join(', ')
  return `Finish building this shipment first — it still needs: ${labels}`
}

function freightSubject(freight: unknown): RequiredFieldSubject['freight'] {
  const items = Array.isArray(freight) ? freight : []
  let commodity: string | null = null
  let weightLbs = 0
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const row = item as Row
    if (commodity == null) {
      const raw = row.commodity ?? row.description
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text) commodity = text
    }
    const w = typeof row.weightLbs === 'number' ? row.weightLbs : Number(row.weightLbs)
    if (Number.isFinite(w) && w > 0) weightLbs += w
  }
  return { commodity, weightLbs: weightLbs > 0 ? weightLbs : null }
}

function referenceRecord(refs: unknown): Record<string, unknown> {
  if (refs != null && typeof refs === 'object' && !Array.isArray(refs)) {
    return refs as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  if (!Array.isArray(refs)) return out
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue
    const row = ref as Row
    const code = String(row.code ?? '').toLowerCase().replace(/\s+/g, '')
    const value = row.value
    if (!code) continue
    const key = code.replace(/^(po|pickup|delivery|bol)(number|num|#)?$/, '$1')
    if (key !== 'po' && key !== 'pickup' && key !== 'delivery' && key !== 'bol') continue
    if (out[key] == null) {
      out[key] = value
    } else {
      const existing = Array.isArray(out[key]) ? (out[key] as unknown[]) : [out[key]]
      out[key] = existing.concat(value)
    }
  }
  return out
}

/** A DynamoDB `Row` field, read as the string the subject wants or as nothing at all. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function buildSubject(bundle: Bundle): RequiredFieldSubject {
  const stops = bundle.loads.flatMap((load) => readStops(load)).map((stop) => ({
    type: text(stop.type),
    address: stop.address,
    city: text(stop.city),
    state: text(stop.state),
    appt: text(stop.appt),
  }))
  const order = bundle.orders[0] ?? {}
  const rate = Number(order.customerRateCents)
  return {
    stops,
    billToId: text(order.billToId),
    salesRepId: text(bundle.shipment.salesRepId),
    revDivision: text(bundle.shipment.revDivision),
    carrierRepId: text(bundle.shipment.carrierRepId),
    carrierTeamKey: text(bundle.shipment.carrierTeamKey),
    customerRateCents: Number.isFinite(rate) ? rate : null,
    equipmentType: text(order.equipmentType),
    references: referenceRecord(order.references),
    freight: freightSubject(order.freight),
  }
}

async function resolveCustomer(
  deps: BuildGateDeps,
  bundle: Bundle,
): Promise<Row | null> {
  const customerId =
    bundle.orders[0]?.customerId ??
    bundle.shipment.customerId ??
    null
  if (!customerId) return null
  return deps.getById(deps.tables.customer, String(customerId))
}

/**
 * Recompute the required-field list, the missing-field list and the resulting
 * build state from the shipment bundle. Every other function in this module
 * shares this derivation so the cache, the UI and the gate can never disagree.
 */
export async function evaluateBuild(
  deps: BuildGateDeps,
  shipmentId: string,
): Promise<{ requiredFields: string[]; missingFields: string[]; buildState: 'BUILDING' | 'BUILT'; subject: RequiredFieldSubject }> {
  const bundle = (await deps.readBundle(shipmentId)) as unknown as Bundle
  assertNotVoided(bundle.shipment)

  const [settings, customer] = await Promise.all([
    deps.getSettings(),
    resolveCustomer(deps, bundle),
  ])

  const requiredFields = resolveRequiredFields(settings, customer)
  const subject = buildSubject(bundle)
  const missingFields = missingRequiredFields(subject, requiredFields)
  const buildState = missingFields.length > 0 ? 'BUILDING' : 'BUILT'

  return { requiredFields, missingFields, buildState, subject }
}

/**
 * What this shipment still needs, without writing anything.
 *
 * Shipments with no `buildState` are reported as BUILT, because they predate
 * this gate and were built by a person.
 */
export async function checkBuildGate(deps: BuildGateDeps, input: Row): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const { requiredFields, missingFields, buildState: computed, subject } = await evaluateBuild(deps, shipmentId)

  const bundle = (await deps.readBundle(shipmentId)) as unknown as Bundle
  const effective = effectiveBuildState(bundle.shipment)

  return {
    shipment: bundle.shipment,
    requiredFields,
    missingFields,
    buildState: effective,
    computedBuildState: computed,
    needs: needsLine(missingFields),
    subject,
  }
}

/**
 * Recompute and persist: BUILDING -> BUILT when nothing is missing.
 *
 * Requires `expectedUpdatedAt` and CASes the Shipment. Already-BUILT shipments
 * are recomputed and left alone (idempotent). Shipments with no `buildState`
 * are treated as BUILT and are never flipped back to BUILDING.
 */
export async function completeBuild(
  deps: BuildGateDeps,
  input: Row,
  caller: Caller,
): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)

  const { requiredFields, missingFields, subject } = await evaluateBuild(deps, shipmentId)
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)

  const currentState = effectiveBuildState(shipment)

  // A BUILDING shipment may only become BUILT once every required field is filled.
  if (currentState === 'BUILDING' && missingFields.length > 0) {
    throw new Error(buildRefusal(missingFields))
  }

  const targetState = missingFields.length === 0 ? 'BUILT' : currentState
  const now = deps.now()
  const patch: Row = {
    buildState: targetState,
    missingFields,
    updatedAt: now,
    updatedBy: caller.email,
  }

  await deps.transact([updateItemTx(deps.tables.shipment, shipmentId, patch, expectedUpdatedAt)])

  await deps.writeAudit('SHIPMENT', shipmentId, targetState === 'BUILT' ? 'COMPLETE_BUILD' : 'COMPLETE_BUILD:NOOP', caller, {
    buildState: targetState,
    previousBuildState: shipment.buildState ?? null,
    missingFields,
  })

  return {
    shipment: { ...shipment, ...patch },
    requiredFields,
    missingFields,
    buildState: targetState,
    needs: needsLine(missingFields),
    subject,
  }
}

/**
 * The one refusal every downstream action shares. Throws with the Needs: sentence
 * when the shipment is still BUILDING; it is a no-op for BUILT or for shipments
 * that predate the gate.
 */
export function assertBuilt(shipment: Row): void {
  if (effectiveBuildState(shipment) !== 'BUILDING') return
  const missing = Array.isArray(shipment.missingFields) ? (shipment.missingFields as string[]) : []
  throw new Error(buildRefusal(missing))
}
