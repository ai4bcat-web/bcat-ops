/**
 * LANE_INTELLIGENCE — the two history sections of the Rate-intelligence panel, read server-side.
 *
 * "What we ran this lane for" reads `LaneRateSample` (live loads and the imported Aljex history, ~10k
 * rows) through its two lane GSIs with the date floor pushed into the key condition, so a lane costs
 * one or two bounded Query reads, never a scan. "What we quoted this lane for" reads `Quote` through
 * the `quoteMonth` GSI, one Query per month of the 24-month window (Quote has no lane index; its
 * month index is the only bounded way in, and a month of quotes is small). Past months never change
 * enough to matter inside a panel session, so they are memoised per Lambda container; the current
 * month and the whole answer are cached for a minute.
 *
 * Matching, equipment and statistics are `src/lib/laneMatch` / `laneIntel` — the same code the tests
 * and the browser's panel use.
 */
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

import { optionalString } from '../_shared/actionInputs'
import { readStops, type Row } from '../_shared/shipmentStore'
import {
  LANE_INTEL_LIST_LIMIT,
  LANE_INTEL_MONTHS,
  laneIntelFloor,
  laneIntelMonths,
  laneQuoteRows,
  laneQuoteStats,
  laneRunRows,
  laneRunWindows,
  laneRunStats,
  type LaneIntelligence,
} from '../../../src/lib/laneIntel'
import { laneKey3OfSpec, laneKeyOfSpec, lanePlace, placeUsable, type LaneSpec } from '../../../src/lib/laneMatch'
import type { LaneRateSampleRecord, QuoteRecord } from '../../../src/types/tms'

export const IDX_SAMPLES_BY_LANE = 'laneRateSamplesByLaneKeyAndDate'
export const IDX_SAMPLES_BY_LANE3 = 'laneRateSamplesByLaneKey3AndDate'
export const IDX_QUOTES_BY_MONTH = 'quotesByQuoteMonthAndQuoteDate'

/** Pages (of ≤1 MB) one lane read may take: a hard ceiling on cost, far above a lane's real history. */
const MAX_PAGES = 6
const PAST_MONTH_TTL_MS = 10 * 60_000

const SAMPLE_FIELDS = [
  'id', 'loadId', 'divisionKey', 'laneKey', 'laneKey3', 'date', 'customerName', 'carrierName', 'assignmentKind', 'equipmentType',
  'customerRateCents', 'revenueCents', 'carrierRateCents', 'costCents', 'profitCents', 'marginBps',
  'shipmentNumber', 'excluded', 'source',
]
const QUOTE_FIELDS = [
  'id', 'side', 'status', 'shipmentId', 'lostReason', 'expiresAt', 'quoteDate', 'customerName', 'amountCents',
  'customerRateCents', 'equipmentType', 'laneKey', 'laneKey3',
]

export interface LaneIntelDeps {
  db: DynamoDBClient
  /** `load` is read (one GetItem per candidate) to compare exact ZIPs; without it the ZIP rule is skipped. */
  tables: { quote: string; laneSample: string; load?: string }
  now(): string
}

interface Cached<T> { at: number; value: T }
const monthCache = new Map<string, Cached<{ rows: QuoteRecord[]; truncated: boolean }>>()

/** Test seam: the caches are module state. */
export function clearLaneIntelCache(): void {
  monthCache.clear()
}

const projection = (fields: string[]) => ({
  ProjectionExpression: fields.map((_, i) => `#p${i}`).join(', '),
  Names: Object.fromEntries(fields.map((f, i) => [`#p${i}`, f])),
})

async function queryPages(
  db: DynamoDBClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = []
  let lastKey: Record<string, never> | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await db.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey as never }))
    if (result.Items) rows.push(...result.Items.map((i) => unmarshall(i)))
    if (!result.LastEvaluatedKey) return { rows, truncated: false }
    lastKey = result.LastEvaluatedKey as never
  }
  return { rows, truncated: true }
}

async function sampleRows(
  deps: LaneIntelDeps,
  index: string,
  keyName: string,
  keyValue: string,
  fromDate: string,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const p = projection(SAMPLE_FIELDS)
  return queryPages(deps.db, {
    TableName: deps.tables.laneSample,
    IndexName: index,
    KeyConditionExpression: '#k = :v AND #d >= :from',
    ProjectionExpression: p.ProjectionExpression,
    ExpressionAttributeNames: { ...p.Names, '#k': keyName, '#d': 'date' },
    ExpressionAttributeValues: { ':v': { S: keyValue }, ':from': { S: fromDate } },
    ScanIndexForward: false,
  })
}

async function monthQuotes(deps: LaneIntelDeps, month: string, currentMonth: string): Promise<{ rows: QuoteRecord[]; truncated: boolean }> {
  // The current month is never cached: a quote saved, sent or marked lost a moment ago must show up on the
  // next read. Past months are effectively closed books and are memoised.
  const nowMs = Date.parse(deps.now())
  const hit = month === currentMonth ? undefined : monthCache.get(month)
  if (hit && nowMs - hit.at < PAST_MONTH_TTL_MS) return hit.value
  const p = projection(QUOTE_FIELDS)
  const { rows, truncated } = await queryPages(deps.db, {
    TableName: deps.tables.quote,
    IndexName: IDX_QUOTES_BY_MONTH,
    KeyConditionExpression: '#m = :m',
    ProjectionExpression: p.ProjectionExpression,
    ExpressionAttributeNames: { ...p.Names, '#m': 'quoteMonth' },
    ExpressionAttributeValues: { ':m': { S: month } },
    ScanIndexForward: false,
  })
  const value = { rows: rows as unknown as QuoteRecord[], truncated }
  if (month !== currentMonth) monthCache.set(month, { at: nowMs, value })
  return value
}

/** The request's lane. Each end needs a city + state or a ZIP; an end with neither cannot be looked up. */
export function laneSpecFromInput(input: Row): LaneSpec {
  const spec: LaneSpec = {
    origin: lanePlace({ city: optionalString(input.originCity, 120), state: optionalString(input.originState, 40), zip: optionalString(input.originZip, 12) }),
    destination: lanePlace({ city: optionalString(input.destinationCity, 120), state: optionalString(input.destinationState, 40), zip: optionalString(input.destinationZip, 12) }),
  }
  if (!placeUsable(spec.origin)) throw new Error('originCity and originState (or originZip) are required')
  if (!placeUsable(spec.destination)) throw new Error('destinationCity and destinationState (or destinationZip) are required')
  return spec
}

/** Which side of the business a sample was run on: BCAT Logistics (brokerage) or Ivan Cartage (own trucks). */
export type LaneClass = 'BROKERAGE' | 'IVAN'

export function laneClassOfSample(row: Pick<LaneRateSampleRecord, 'divisionKey' | 'assignmentKind'>): LaneClass | null {
  if (row.divisionKey === 'BCAT_LOGISTICS') return 'BROKERAGE'
  if (row.divisionKey === 'IVAN_CARTAGE') return 'IVAN'
  // An older sample with no division: a carrier hauled it = brokerage, our own truck = Ivan.
  if (row.assignmentKind === 'CARRIER') return 'BROKERAGE'
  if (row.assignmentKind === 'OWN_ASSET') return 'IVAN'
  return null
}

const zip5Of = (value: unknown): string | null => {
  const m = String(value ?? '').trim().match(/^(\d{5})/)
  return m ? m[1]! : null
}

/** The first pickup's and the last delivery's 5-digit ZIPs on a load's stops. */
function endZipsOf(load: Row): { origin: string | null; destination: string | null } {
  const stops = readStops(load)
  const pickups = stops.filter((s) => s.type === 'pickup')
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const first = pickups[0] ?? stops[0]
  const last = deliveries[deliveries.length - 1] ?? stops[stops.length - 1]
  const zipOf = (stop: unknown): string | null => zip5Of(((stop as { address?: { zip?: unknown } } | undefined)?.address ?? {}).zip ?? (stop as { zip?: unknown } | undefined)?.zip)
  return { origin: zipOf(first), destination: zipOf(last) }
}

/** Keep only the samples whose load went from exactly this ZIP to exactly that one (a sample whose load cannot be read is not an exact match). */
async function onlyExactZips(deps: LaneIntelDeps, rows: LaneRateSampleRecord[], originZip: string, destinationZip: string): Promise<LaneRateSampleRecord[]> {
  const table = deps.tables.load
  if (!table) return rows
  const kept: LaneRateSampleRecord[] = []
  const CHUNK = 25
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const answers = await Promise.all(slice.map(async (row) => {
      if (!row.loadId) return false
      try {
        const out = await deps.db.send(new GetItemCommand({ TableName: table, Key: { id: { S: row.loadId } }, ProjectionExpression: 'stops' }))
        if (!out.Item) return false
        const zips = endZipsOf(unmarshall(out.Item))
        return zips.origin === originZip && zips.destination === destinationZip
      } catch {
        return false
      }
    }))
    slice.forEach((row, j) => { if (answers[j]) kept.push(row) })
  }
  return kept
}

export async function getLaneIntelligence(deps: LaneIntelDeps, input: Row): Promise<LaneIntelligence> {
  const spec = laneSpecFromInput(input)
  const equipmentType = optionalString(input.equipmentType, 60)
  const excludeQuoteId = optionalString(input.excludeQuoteId, 80)
  const nowIso = deps.now()
  const laneKey = laneKeyOfSpec(spec)
  const laneKey3 = laneKey3OfSpec(spec)
  if (!laneKey && !laneKey3) {
    // Names and ZIPs are both partial on one end: nothing indexable. Say so rather than scan.
    throw new Error('The lane needs a city and state, or a ZIP, on both ends')
  }

  const fromDate = laneIntelFloor(nowIso, LANE_INTEL_MONTHS)
  const months = laneIntelMonths(nowIso, LANE_INTEL_MONTHS)
  const [exact, zip3, ...monthResults] = await Promise.all([
    laneKey ? sampleRows(deps, IDX_SAMPLES_BY_LANE, 'laneKey', laneKey, fromDate) : Promise.resolve({ rows: [] as Row[], truncated: false }),
    laneKey3 ? sampleRows(deps, IDX_SAMPLES_BY_LANE3, 'laneKey3', laneKey3, fromDate) : Promise.resolve({ rows: [] as Row[], truncated: false }),
    ...months.map((m) => monthQuotes(deps, m, months[months.length - 1])),
  ])

  // The same sample can arrive from both indexes; its id is the identity.
  const byId = new Map<string, LaneRateSampleRecord>()
  for (const row of [...exact.rows, ...zip3.rows]) byId.set(String(row.id), row as unknown as LaneRateSampleRecord)

  // This load's own side of the business: a brokerage load is compared with brokerage runs, an Ivan load with Ivan runs.
  const laneClass: LaneClass | null = input.laneClass === 'BROKERAGE' || input.laneClass === 'IVAN' ? input.laneClass : null
  let candidates = [...byId.values()]
  if (laneClass) candidates = candidates.filter((row) => laneClassOfSample(row) === laneClass)
  // With a full ZIP on both ends, only runs over exactly those ZIPs count.
  const originZip = zip5Of(input.originZip)
  const destinationZip = zip5Of(input.destinationZip)
  if (originZip && destinationZip) candidates = await onlyExactZips(deps, candidates, originZip, destinationZip)

  const runAll = laneRunRows(candidates, spec, { equipmentType, fromDate })
  const quoteAll = laneQuoteRows(monthResults.flatMap((r) => r.rows), spec, { equipmentType, fromDate, nowIso, excludeId: excludeQuoteId })

  const value: LaneIntelligence = {
    laneKey,
    laneKey3,
    equipmentType,
    fromDate,
    months: LANE_INTEL_MONTHS,
    generatedAt: nowIso,
    runs: { stats: laneRunStats(runAll), rows: runAll.slice(0, LANE_INTEL_LIST_LIMIT), windows: laneRunWindows(runAll, nowIso) },
    quotes: { stats: laneQuoteStats(quoteAll), rows: quoteAll.slice(0, LANE_INTEL_LIST_LIMIT) },
    truncated: exact.truncated || zip3.truncated || monthResults.some((r) => r.truncated),
  }
  return value
}
