/**
 * LINK class (Step AW stage C): which existing Load gets a Shipment attached by PRO, which waits for the ID
 * fallback (`BACKFILL_SHIPMENT`), and which a person has to look at. Pure: no table reads, no wall clock.
 *
 * The key is `normalizePro` (trim, "Pro#" label, alphanumerics, upper case). Leading zeros are NEVER stripped
 * (factoring-intake keeps them), so `0123` and `123` are different PROs. A shipment number may carry ONE leading
 * `L` (the counter shape backfill mints for a load with no PRO); it is removed only when the rest still
 * normalises to at least 3 characters. Counter shapes `S######` / `S######-1` never link by PRO.
 */
import { isDerivedPro, normalizePro } from './proNumber'

/** Default shipment prefix of the PRO counter (`TmsSettings.shipmentPrefix`). */
export const DEFAULT_SHIPMENT_PREFIX = 'S'

/** PRO key of a Load: `normalizePro` of `Load.aljexId` (padded, `Pro#`-labelled and plain spellings agree). */
export function linkKeyForLoad(aljexId: string | null | undefined): string | null {
  return normalizePro(aljexId)
}

/**
 * PRO key of a Shipment number or an Aljex PRO: `normalizePro` with ONE leading `L` removed when the rest still
 * normalises to >= 3 characters. A counter-derived number (`S######`, `S######-1`) has no PRO identity: null.
 */
export function linkKeyForShipmentNumber(number: string | null | undefined, shipmentPrefix: string = DEFAULT_SHIPMENT_PREFIX): string | null {
  const key = normalizePro(number)
  if (!key) return null
  if (isDerivedPro(number ?? '', shipmentPrefix)) return null
  if (key.startsWith('L')) {
    const rest = normalizePro((number ?? '').trim().slice(1))
    if (rest) return rest
  }
  return key
}

export type LinkBucket = 'MATCHED_BY_PRO' | 'LINKED_BY_ID' | 'AMBIGUOUS' | 'UNMAPPABLE'

export type LinkReason =
  | 'ALREADY_LINKED'
  | 'DUPLICATE_LOAD_PRO'
  | 'MULTIPLE_SHIPMENTS'
  | 'SHIPMENT_NOT_LINKED'
  | 'PRO_CLAIMED_BY_OTHER_LOAD'
  | 'NO_PRO'
  | 'NOT_IN_EXPORT'
  | 'BACKFILL_SKIP'

export interface LinkLoad {
  id: string
  aljexId?: string | null
  shipmentId?: string | null
}

export interface LinkShipment {
  id: string
  number?: string | null
  loadIds?: readonly string[] | null
}

export interface LinkClaim {
  /** ProClaim id = the PRO key. */
  id: string
  loadId: string
}

export interface LinkInput {
  loads: readonly LinkLoad[]
  /** Shipments already on the target. */
  shipments: readonly LinkShipment[]
  claims: readonly LinkClaim[]
  /** PRO keys present in the Aljex export being linked from (a Load outside it falls to the ID fallback). */
  exportKeys: ReadonlySet<string>
  /** Loads the ID-fallback backfill refuses: loadId -> its skip reason (SHIPMENT_VOIDED, PRO_CLAIMED_BY_OTHER_LOAD, ...). */
  backfillSkips?: ReadonlyMap<string, string>
  shipmentPrefix?: string
}

export interface LinkEntry {
  loadId: string
  /** PRO key, or '' for a Load with no PRO. */
  key: string
  bucket: LinkBucket
  reason?: LinkReason
  /** Skip reason reported by the backfill planner, when `reason` is BACKFILL_SKIP / PRO_CLAIMED_BY_OTHER_LOAD. */
  detail?: string
}

export interface LinkReport {
  matchedByPro: LinkEntry[]
  linkedById: LinkEntry[]
  ambiguous: LinkEntry[]
  unmappable: LinkEntry[]
  /** Loads that already carry a shipmentId: nothing to do (what makes a re-run a no-op). */
  alreadyLinked: LinkEntry[]
  counts: { matchedByPro: number; linkedById: number; ambiguous: number; unmappable: number; alreadyLinked: number; loads: number }
}

/** Sort by load id so the report and its CSV are deterministic. */
const byLoad = (a: LinkEntry, b: LinkEntry): number => (a.loadId < b.loadId ? -1 : a.loadId > b.loadId ? 1 : 0)

/**
 * Bucket every Load. The five lists partition the Loads: `counts.loads` equals their sum.
 *  - alreadyLinked: the Load has a shipmentId.
 *  - ambiguous: two Loads share the PRO key, a Shipment with that PRO exists but is not linked to this Load,
 *    several Shipments resolve to the PRO, or the ProClaim is held by a different Load. Never guessed.
 *  - matchedByPro: the PRO key is in the export and nothing above applies (the importer LINKs it).
 *  - unmappable: no PRO and the backfill planner refuses it (or a backfill skip on a PRO Load that is not a claim clash).
 *  - linkedById: every other unlinked Load; `BACKFILL_SHIPMENT` links it by Load id.
 */
export function classifyLinkCandidates(input: LinkInput): LinkReport {
  const prefix = input.shipmentPrefix ?? DEFAULT_SHIPMENT_PREFIX
  const keyCount = new Map<string, number>()
  for (const l of input.loads) {
    const k = linkKeyForLoad(l.aljexId)
    if (k) keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
  }
  const shipmentsByKey = new Map<string, LinkShipment[]>()
  for (const s of input.shipments) {
    const k = linkKeyForShipmentNumber(s.number, prefix)
    if (k) shipmentsByKey.set(k, [...(shipmentsByKey.get(k) ?? []), s])
  }
  const claimByKey = new Map(input.claims.map((c) => [c.id, c.loadId]))

  const report: LinkReport = { matchedByPro: [], linkedById: [], ambiguous: [], unmappable: [], alreadyLinked: [], counts: { matchedByPro: 0, linkedById: 0, ambiguous: 0, unmappable: 0, alreadyLinked: 0, loads: 0 } }
  for (const l of input.loads) {
    const key = linkKeyForLoad(l.aljexId) ?? ''
    const base = { loadId: l.id, key }
    if (l.shipmentId) {
      report.alreadyLinked.push({ ...base, bucket: 'MATCHED_BY_PRO', reason: 'ALREADY_LINKED' })
      continue
    }
    const skip = input.backfillSkips?.get(l.id)
    if (!key) {
      if (skip) report.unmappable.push({ ...base, bucket: 'UNMAPPABLE', reason: 'BACKFILL_SKIP', detail: skip })
      else report.linkedById.push({ ...base, bucket: 'LINKED_BY_ID', reason: 'NO_PRO' })
      continue
    }
    const shipments = shipmentsByKey.get(key) ?? []
    const claim = claimByKey.get(key)
    if ((keyCount.get(key) ?? 0) > 1) report.ambiguous.push({ ...base, bucket: 'AMBIGUOUS', reason: 'DUPLICATE_LOAD_PRO' })
    else if (shipments.length > 1) report.ambiguous.push({ ...base, bucket: 'AMBIGUOUS', reason: 'MULTIPLE_SHIPMENTS' })
    else if (shipments.length === 1) report.ambiguous.push({ ...base, bucket: 'AMBIGUOUS', reason: 'SHIPMENT_NOT_LINKED' })
    else if (claim !== undefined && claim !== l.id) report.ambiguous.push({ ...base, bucket: 'AMBIGUOUS', reason: 'PRO_CLAIMED_BY_OTHER_LOAD' })
    else if (input.exportKeys.has(key)) report.matchedByPro.push({ ...base, bucket: 'MATCHED_BY_PRO' })
    else if (skip) {
      if (skip === 'PRO_CLAIMED_BY_OTHER_LOAD') report.ambiguous.push({ ...base, bucket: 'AMBIGUOUS', reason: 'PRO_CLAIMED_BY_OTHER_LOAD', detail: skip })
      else report.unmappable.push({ ...base, bucket: 'UNMAPPABLE', reason: 'BACKFILL_SKIP', detail: skip })
    } else report.linkedById.push({ ...base, bucket: 'LINKED_BY_ID', reason: 'NOT_IN_EXPORT' })
  }
  for (const list of [report.matchedByPro, report.linkedById, report.ambiguous, report.unmappable, report.alreadyLinked]) list.sort(byLoad)
  report.counts = {
    matchedByPro: report.matchedByPro.length,
    linkedById: report.linkedById.length,
    ambiguous: report.ambiguous.length,
    unmappable: report.unmappable.length,
    alreadyLinked: report.alreadyLinked.length,
    loads: input.loads.length,
  }
  return report
}

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** `link-report.csv`: one row per Load (ids, PRO key, bucket, reason: no names, no values). */
export function linkReportCsv(report: LinkReport): string {
  const rows = [...report.matchedByPro, ...report.linkedById, ...report.ambiguous, ...report.unmappable, ...report.alreadyLinked]
  const lines = ['load_id,pro,bucket,reason,detail', ...rows.map((e) => [e.loadId, e.key, e.reason === 'ALREADY_LINKED' ? 'ALREADY_LINKED' : e.bucket, e.reason ?? '', e.detail ?? ''].map(csvCell).join(','))]
  return `${lines.join('\n')}\n`
}

/** `link-report.md`: the four buckets and the already-linked count, with the sum check against the Load count. */
export function linkReportMarkdown(report: LinkReport): string {
  const c = report.counts
  const sum = c.matchedByPro + c.linkedById + c.ambiguous + c.unmappable + c.alreadyLinked
  const example = (list: LinkEntry[]): string => (list.length ? list.slice(0, 10).map((e) => e.key || e.loadId).join(', ') + (list.length > 10 ? ', ...' : '') : '')
  return [
    '# Load to shipment link report',
    '',
    `Loads: ${c.loads}. Buckets add up: ${sum === c.loads ? 'YES' : `NO (${sum})`}.`,
    '',
    '| Bucket | Loads | Examples (PRO) |',
    '|---|---:|---|',
    `| Matched by PRO (importer LINK) | ${c.matchedByPro} | ${example(report.matchedByPro)} |`,
    `| Linked by ID (backfill) | ${c.linkedById} | ${example(report.linkedById)} |`,
    `| Ambiguous (needs Ryne) | ${c.ambiguous} | ${example(report.ambiguous)} |`,
    `| Unmappable | ${c.unmappable} | ${example(report.unmappable)} |`,
    `| Already linked (no action) | ${c.alreadyLinked} | |`,
    '',
  ].join('\n')
}
