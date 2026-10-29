/**
 * Which business earns a shipment — resolved here, written on Shipment and Load.
 *
 * Ryne, 2026-10-28: every shipment carries its revenue division, and none of it is
 * hard-coded. The divisions and the ordered rules that tag a shipment are rows an
 * admin edits (`OwnershipDivision` / `OwnershipRule`, written by the directory
 * router); `src/lib/ownership.ts` is the whole decision and this module is only the
 * plumbing around it: read the taxonomy, build the rule context from the records a
 * booking already has in hand, and write the result on both mirrored rows.
 *
 * Two things are deliberate:
 *
 * - **Seeds are a fallback, not a constant.** An empty table means the seed action
 *   has not run yet, and a shipment booked in that window must still be tagged the
 *   way Ryne described. The moment a row exists, the table wins.
 * - **A hand tag beats the rules.** `revTagSource = 'HAND'` is a person saying who
 *   earned this load; re-resolving over it would erase that on the next carrier
 *   change. Every automatic path goes through `applyTag`, which refuses to.
 */
import { ScanCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

import {
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  type Row,
} from '../_shared/shipmentStore'
import {
  SEED_DIVISIONS,
  SEED_RULES,
  resolveDivision,
  shipmentContextFor,
  type ResolveContext,
  type Resolution,
} from '../../../src/lib/ownership'
import type { OwnershipCondition, OwnershipDivisionRecord, OwnershipRuleRecord } from '../../../src/types/tms'

/** The division/rule columns the resolver reads. Audit columns are irrelevant here. */
type DivisionRow = Pick<OwnershipDivisionRecord, 'id' | 'code' | 'parentId' | 'sortOrder' | 'active' | 'name'>
type RuleRow = Pick<OwnershipRuleRecord, 'id' | 'name' | 'active' | 'sortOrder' | 'condition' | 'divisionCode'>

export interface Taxonomy {
  divisions: DivisionRow[]
  rules: RuleRow[]
  /** True when a table was empty and its seed answered instead. */
  seededDivisions: boolean
  seededRules: boolean
}

/** What the tag writer needs from the router: its client, its tables and its writers. */
export interface OwnershipDeps {
  db: DynamoDBClient
  tables: {
    shipment: string
    order: string
    load: string
    loadCarrier: string
    driver: string
    division: string
    rule: string
  }
  getById: (tableName: string, id: string) => Promise<Row | null>
  queryIndex: (tableName: string, indexName: string, keyName: string, keyValue: string) => Promise<Row[]>
}

/** The three columns a tag is, on both Shipment and Load. */
export interface ShipmentTag {
  revDivision: string | null
  revSubdivision: string | null
  revRuleId: string | null
}

/** The records one resolution reads: the shipment's single order, its load, its ACTIVE leg and that leg's driver. */
export interface ShipmentRecords {
  shipment: Row
  order: Row | null
  load: Row | null
  loadCarrier: Row | null
  driver: Row | null
}

/**
 * A container lives minutes to hours and the division tree changes at the speed an
 * admin edits it. Sixty seconds is long enough that a board refresh does not re-scan
 * two tables per booking, short enough that an edit shows up while the admin is
 * still looking at the page.
 */
export const TAXONOMY_TTL_MS = 60_000

let cached: { at: number; value: Taxonomy } | null = null

/** Tests (and ENSURE_OWNERSHIP_SEED's caller) start from a cold container. */
export function resetTaxonomyCache(): void {
  cached = null
}

async function scanAll(db: DynamoDBClient, tableName: string): Promise<Row[]> {
  if (!tableName) return []
  const items: Row[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const result = await db.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey as never, Limit: 1000 }),
    )
    if (result.Items) items.push(...result.Items.map((i) => unmarshall(i)))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

/** `a.json()` comes back as a map; a row written as a string is still readable. */
function conditionOf(value: unknown): OwnershipCondition | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as OwnershipCondition
    } catch {
      return null
    }
  }
  return value as OwnershipCondition
}

function divisionRowOf(row: Row): DivisionRow {
  return {
    id: String(row.id ?? row.code ?? ''),
    code: String(row.code ?? row.id ?? ''),
    name: String(row.name ?? row.code ?? ''),
    parentId: typeof row.parentId === 'string' && row.parentId !== '' ? row.parentId : null,
    sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
    active: row.active !== false,
  }
}

/**
 * One stored rule, or null when its condition cannot be read at all. A rule nobody
 * can parse is not a rule that silently matches everything — it is dropped, and the
 * next one (ultimately the catch-all) answers instead.
 */
function ruleRowOf(row: Row): RuleRow | null {
  const condition = conditionOf(row.condition)
  if (!condition) return null
  return {
    id: String(row.id ?? ''),
    name: typeof row.name === 'string' ? row.name : null,
    active: row.active !== false,
    sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
    condition,
    divisionCode: String(row.divisionCode ?? ''),
  }
}

/**
 * The division tree and the rule list, cached per container.
 *
 * Each table falls back to its seed on its own: an admin who archived every rule
 * but kept the divisions has said something about rules, not about divisions.
 */
export async function loadTaxonomy(deps: OwnershipDeps): Promise<Taxonomy> {
  const now = Date.now()
  if (cached && now - cached.at < TAXONOMY_TTL_MS) return cached.value

  const [divisionRows, ruleRows] = await Promise.all([
    scanAll(deps.db, deps.tables.division),
    scanAll(deps.db, deps.tables.rule),
  ])

  const value: Taxonomy = {
    divisions: divisionRows.length > 0 ? divisionRows.map(divisionRowOf) : SEED_DIVISIONS.map((d) => ({ ...d })),
    rules: ruleRows.length > 0
      ? ruleRows.map(ruleRowOf).filter((rule): rule is RuleRow => rule != null)
      : SEED_RULES.map((r) => ({ ...r })),
    seededDivisions: divisionRows.length === 0,
    seededRules: ruleRows.length === 0,
  }
  cached = { at: now, value }
  return value
}

/**
 * Everything one resolution looks at.
 *
 * A shipment has one order and one load by construction (Step R's "one record"
 * rule); where an older row has more, the first of each is the one the tag belongs
 * to, which is also the one every board column reads.
 */
export async function readShipmentRecords(deps: OwnershipDeps, shipmentId: string): Promise<ShipmentRecords> {
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const [orders, loads, legs] = await Promise.all([
    deps.queryIndex(deps.tables.order, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    deps.queryIndex(deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId),
    deps.queryIndex(deps.tables.loadCarrier, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId),
  ])
  loads.sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  const load = loads[0] ?? null
  const loadCarrier = legs.find(
    (leg) => leg.status === 'ACTIVE' && (load == null || String(leg.loadId ?? '') === String(load.id)),
  ) ?? null
  const driverId = typeof loadCarrier?.driverId === 'string' ? loadCarrier.driverId : ''
  const driver = driverId ? await deps.getById(deps.tables.driver, driverId) : null
  return { shipment, order: orders[0] ?? null, load, loadCarrier, driver }
}

/** The rule context these records describe, exactly as `shipmentContextFor` builds it. */
export function contextOf(records: ShipmentRecords): ResolveContext {
  return shipmentContextFor({
    shipment: records.shipment as never,
    order: records.order as never,
    load: records.load as never,
    loadCarrier: records.loadCarrier as never,
    driver: records.driver as never,
  })
}

/** First active rule whose condition holds, as a tag. */
export function tagFor(taxonomy: Taxonomy, context: ResolveContext): { tag: ShipmentTag; resolution: Resolution } {
  const resolution = resolveDivision(taxonomy.divisions, taxonomy.rules, context)
  return {
    resolution,
    tag: {
      revDivision: resolution.revDivision,
      revSubdivision: resolution.revSubdivision,
      revRuleId: resolution.ruleId,
    },
  }
}

export interface ResolvedShipment {
  records: ShipmentRecords
  context: ResolveContext
  resolution: Resolution
  tag: ShipmentTag
}

/** Read one shipment's records and resolve them. Writes nothing. */
export async function resolveForShipment(
  deps: OwnershipDeps,
  shipmentIdOrRecords: string | ShipmentRecords,
): Promise<ResolvedShipment> {
  const records = typeof shipmentIdOrRecords === 'string'
    ? await readShipmentRecords(deps, shipmentIdOrRecords)
    : shipmentIdOrRecords
  const taxonomy = await loadTaxonomy(deps)
  const context = contextOf(records)
  const { tag, resolution } = tagFor(taxonomy, context)
  return { records, context, resolution, tag }
}

/** The tag as a Load carries it: the three columns plus where it came from. */
export function tagPatch(tag: ShipmentTag, source: 'RULE' | 'HAND'): Row {
  return {
    revDivision: tag.revDivision,
    revSubdivision: tag.revSubdivision,
    revRuleId: tag.revRuleId,
    revTagSource: source,
  }
}

/**
 * The tag as the Shipment carries it. Only the shipment records who tagged it by
 * hand — the Load is a mirror of the answer, not of the conversation — and a rule
 * re-resolve clears the name, because no person is standing behind a rule's answer.
 */
export function shipmentTagPatch(tag: ShipmentTag, source: 'RULE' | 'HAND', taggedBy: string | null): Row {
  return { ...tagPatch(tag, source), revTaggedBy: source === 'HAND' ? taggedBy : null }
}

/** True when the row already says exactly this, so an unchanged row is not rewritten. */
export function sameTag(
  row: Row | null | undefined,
  tag: ShipmentTag,
  source: 'RULE' | 'HAND',
  taggedBy: string | null = null,
): boolean {
  if (!row) return false
  return (row.revDivision ?? null) === tag.revDivision
    && (row.revSubdivision ?? null) === tag.revSubdivision
    && (row.revRuleId ?? null) === tag.revRuleId
    && (row.revTagSource ?? null) === source
    && (row.revTaggedBy ?? null) === taggedBy
}
