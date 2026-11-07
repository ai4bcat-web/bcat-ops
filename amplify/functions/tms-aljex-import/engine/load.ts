/**
 * P4: one transaction per PRO. Classifies each staged row against the target (CREATE / OWN / ENRICH / LINK /
 * AMBIGUOUS / CONFLICT), writes the final aggregate, and keeps the outcome counters the conservation
 * invariant is asserted on. The same code runs against the overlay store for PLAN. LINK reuses the existing
 * Load of the PRO (link-only conditional UpdateItem, never an insert or an edit of the Load); AMBIGUOUS is
 * never guessed: it is counted as a conflict and listed for the owner.
 */
import type { AljexImportJob, EngineStore } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import type { AljexProfile } from '../../../../src/lib/aljex/profile'
import { linkKeyForShipmentNumber, type LinkReason } from '../../../../src/lib/shipmentLink'
import { normalizePro } from '../../../../src/lib/proNumber'
import { buildLoadAggregate, buildMemoRow, rowIds, type LoadEnv } from './aggregate'
import { loadCarrierLookup, loadCustomerLookup, loadLocationMaps, scanRows, text } from './directory'
import { buildEnrich, type ExistingLoad } from './enrich'
import { readChunk, type StageData } from './stage'
import { bump, type Counts, type Finding, type ProClass } from './types'
import { sleep } from './util'

export interface ExistingIndex {
  claims: Map<string, string>
  loads: Map<string, ExistingLoad & { hasShipment: boolean }>
  /** PRO keys that more than one Load carries (never linked or enriched: the owner decides). */
  duplicateLoadKeys: Set<string>
  /** PRO key (shipment number via `linkKeyForShipmentNumber`) -> Shipment ids already on the target. */
  shipmentsByKey: Map<string, string[]>
}

export async function loadExistingIndex(store: EngineStore): Promise<ExistingIndex> {
  const claims = new Map<string, string>()
  for (const c of await scanRows(store, 'proClaim', ['id', 'loadId'])) claims.set(text(c.id), text(c.loadId))
  const loads = new Map<string, ExistingLoad & { hasShipment: boolean }>()
  const duplicateLoadKeys = new Set<string>()
  for (const l of await scanRows(store, 'load', ['id', 'aljexId', 'shipmentId', 'orderId', 'activeLoadCarrierId'])) {
    const key = normalizePro(text(l.aljexId))
    if (!key) continue
    if (loads.has(key)) duplicateLoadKeys.add(key)
    loads.set(key, { id: text(l.id), shipmentId: text(l.shipmentId), orderId: text(l.orderId), activeLoadCarrierId: text(l.activeLoadCarrierId), hasShipment: Boolean(text(l.shipmentId)) })
  }
  const [settings] = await store.getMany('settings', ['default'])
  const prefix = text(settings?.shipmentPrefix) || undefined
  const shipmentsByKey = new Map<string, string[]>()
  for (const s of await scanRows(store, 'shipment', ['id', 'number'])) {
    const key = linkKeyForShipmentNumber(text(s.number), prefix)
    if (key) shipmentsByKey.set(key, [...(shipmentsByKey.get(key) ?? []), text(s.id)])
  }
  return { claims, loads, duplicateLoadKeys, shipmentsByKey }
}

export interface ProDecision {
  klass: ProClass
  /** The Load key the row resolved to (the row's PRO key, or the same key with one leading L removed). */
  liveKey: string
  reason?: LinkReason
}

/** The single classification PLAN and APPLY share. Pure over the index. */
export function classifyPro(row: CanonicalRow, existing: ExistingIndex): ProDecision {
  const key = row.proKey as string
  const alt = linkKeyForShipmentNumber(row.pro)
  const liveKey = existing.loads.has(key) ? key : alt && existing.loads.has(alt) ? alt : key
  const claim = existing.claims.get(key)
  if (claim === rowIds(row).loadId) return { klass: 'OWN', liveKey }
  const live = existing.loads.get(liveKey)
  if (!live) return { klass: claim ? 'CONFLICT' : 'CREATE', liveKey }
  if (existing.duplicateLoadKeys.has(liveKey)) return { klass: 'AMBIGUOUS', liveKey, reason: 'DUPLICATE_LOAD_PRO' }
  if (live.hasShipment) return { klass: 'ENRICH', liveKey }
  const shipments = existing.shipmentsByKey.get(liveKey) ?? []
  if (shipments.length > 1) return { klass: 'AMBIGUOUS', liveKey, reason: 'MULTIPLE_SHIPMENTS' }
  if (shipments.length === 1) return { klass: 'AMBIGUOUS', liveKey, reason: 'SHIPMENT_NOT_LINKED' }
  const held = existing.claims.get(liveKey)
  if (held !== undefined && held !== live.id) return { klass: 'AMBIGUOUS', liveKey, reason: 'PRO_CLAIMED_BY_OTHER_LOAD' }
  return { klass: 'LINK', liveKey }
}

export async function buildLoadEnv(store: EngineStore, runId: string, stage: StageData, profile: AljexProfile): Promise<LoadEnv> {
  const [customers, carriers, loc] = await Promise.all([loadCustomerLookup(store), loadCarrierLookup(store), loadLocationMaps(store)])
  const [settingsRow] = await store.getMany('settings', ['default'])
  const factoringIds = new Set<string>()
  for (const f of await scanRows(store, 'factoringItem', ['id'])) factoringIds.add(normalizePro(text(f.id)) ?? text(f.id))
  const drivers = new Map<string, string[]>()
  for (const d of await scanRows(store, 'driver', ['id', 'name', 'active'])) {
    if (d.active === false || !text(d.name)) continue
    const key = text(d.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    drivers.set(key, [...(drivers.get(key) ?? []), text(d.id)])
  }
  const invoiceOwners = new Map<string, string>()
  for (const i of await scanRows(store, 'invoice', ['id', 'orderId'])) invoiceOwners.set(text(i.id), text(i.orderId))
  return {
    runId,
    stageHash: stage.index.stageHash,
    profile,
    window: stage.masters.window,
    customers,
    carriers,
    locations: loc.maps,
    settings: {
      defaultPaymentTermsDays: typeof settingsRow?.defaultPaymentTermsDays === 'number' ? settingsRow.defaultPaymentTermsDays : null,
      defaultCarrierTermsDays: typeof settingsRow?.defaultCarrierTermsDays === 'number' ? settingsRow.defaultCarrierTermsDays : null,
    },
    factoringIds,
    drivers: { byName: drivers },
    invoiceOwners,
    cutoffDate: stage.index.history?.cutoffDate ?? null,
    memos: stage.masters.memos?.byInvoice ?? {},
    memoOrphans: new Map((stage.masters.memos?.orphans ?? []).map((o) => [o.memoPro, o])),
    actor: 'aljex-import',
  }
}

export const BATCH_ROWS = 25
const CONCURRENCY = 8
const MAX_THROTTLE_RETRIES = 6

export interface LoadPhaseResult {
  done: boolean
  cursor: { chunk: number; offset: number }
}

/** Run the LOAD phase from `cursor` until it ends or `deadlineMs` passes. `persist` is called after every batch. */
export async function runLoadPhase(args: {
  store: EngineStore
  job: AljexImportJob
  runId: string
  stage: StageData
  rootJobId: string
  env: LoadEnv
  counts: Counts
  cursor: { chunk: number; offset: number }
  deadlineMs: number
  rowsDone: number
  persist(from: { chunk: number; offset: number }, next: { chunk: number; offset: number }, batchFindings: Finding[], rowsDone: number): Promise<boolean>
}): Promise<LoadPhaseResult & { rowsDone: number; stopped: boolean }> {
  const { store, stage, env, counts } = args
  const existing = await loadExistingIndex(store)
  let { chunk, offset } = args.cursor
  let rowsDone = args.rowsDone

  for (; chunk < stage.masters.chunkCount; chunk++) {
    const rows = await readChunk(store, args.rootJobId, chunk)
    for (; offset < rows.length; offset += BATCH_ROWS) {
      if (Date.now() > args.deadlineMs) return { done: false, cursor: { chunk, offset }, rowsDone, stopped: false }
      const batch = rows.slice(offset, offset + BATCH_ROWS)
      const findings: Finding[] = []
      await processBatch(store, batch, existing, env, counts, findings, args.runId)
      rowsDone += batch.length
      const next = offset + BATCH_ROWS >= rows.length ? { chunk: chunk + 1, offset: 0 } : { chunk, offset: offset + BATCH_ROWS }
      const keepGoing = await args.persist({ chunk, offset }, next, findings, rowsDone)
      if (!keepGoing) return { done: false, cursor: next, rowsDone, stopped: true }
    }
    offset = 0
  }
  return { done: true, cursor: { chunk: stage.masters.chunkCount, offset: 0 }, rowsDone, stopped: false }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }))
}

async function processBatch(store: EngineStore, batch: CanonicalRow[], existing: ExistingIndex, env: LoadEnv, counts: Counts, findings: Finding[], runId: string): Promise<void> {
  // Own rows of this run count as created (a resumed batch re-meets what it already wrote).
  const ownCandidates = batch.filter((r) => r.kind === 'LOAD' && existing.claims.get(r.proKey as string) === rowIds(r).loadId)
  // Memos own no PRO claim: their lossless source row is the only thing written, found by its id.
  const memoRows = batch.filter((r) => r.kind !== 'LOAD')
  const memoExisting = memoRows.length ? await store.getMany('legacyAljexRow', memoRows.map((r) => `aljex:memo:${r.pro}`)) : []
  const memoRun = new Map(memoExisting.map((r) => [text(r.id), text(r.importRunId)]))
  const ownShipmentIds = ownCandidates.length ? await store.getMany('shipment', ownCandidates.map((r) => rowIds(r).shipmentId)) : []
  const ownRun = new Map(ownShipmentIds.map((s) => [text(s.id), text(s.importRunId)]))
  const decisions = new Map(batch.filter((r) => r.kind === 'LOAD').map((r) => [r, classifyPro(r, existing)] as const))
  // A LINK keeps an existing LoadFinancials row untouched: look them up once per batch.
  const linkLoadIds = [...decisions.values()].filter((d) => d.klass === 'LINK').map((d) => existing.loads.get(d.liveKey)!.id)
  const haveFinancials = new Set((linkLoadIds.length ? await store.getMany('loadFinancials', linkLoadIds) : []).map((f) => text(f.id)))
  await pool(batch, CONCURRENCY, async (row) => {
    if (row.kind !== 'LOAD') {
      const agg = buildMemoRow(row, env)
      for (const f of agg.findings) findings.push({ code: f.code, pro: row.pro, rowNumber: row.rowNumber, ...(f.detail ? { detail: f.detail } : {}) })
      const prior = memoRun.get(`aljex:memo:${row.pro}`)
      if (prior === undefined) {
        const tx = await transactWithRetry(store, agg.items, `memo ${row.pro}`)
        if (!tx.ok) {
          bump(counts, row.kind, 'errors')
          findings.push({ code: 'TX_ERROR', pro: row.pro, rowNumber: row.rowNumber, detail: tx.message })
          return
        }
      }
      bump(counts, row.kind, !agg.memoApplied ? 'skipped' : prior === undefined || prior === runId ? 'created' : 'matched')
      return
    }
    const entity = row.kind
    const found = (code: string, detail?: string) => findings.push({ code, pro: row.pro, rowNumber: row.rowNumber, ...(detail ? { detail } : {}) })
    const decision = decisions.get(row)!
    const klass = decision.klass
    if (klass === 'CONFLICT') {
      bump(counts, entity, 'conflicts')
      found('PRO_CLAIMED_ELSEWHERE')
      return
    }
    if (klass === 'AMBIGUOUS') {
      bump(counts, entity, 'conflicts')
      found('LINK_AMBIGUOUS', decision.reason)
      return
    }
    if (klass === 'ENRICH') {
      const live = existing.loads.get(decision.liveKey)!
      const res = await buildEnrich(store, row, live, env)
      for (const f of res.findings) found(f.code, f.detail)
      if (res.invoiceExpected) bump(counts, 'INVOICE', 'staged')
      if (res.outcome === 'mismatch') {
        bump(counts, entity, 'conflicts')
        if (res.invoiceExpected) bump(counts, 'INVOICE', 'conflicts')
        return
      }
      if (res.items.length) {
        const tx = await transactWithRetry(store, res.items, `enrich ${row.pro}`)
        if (!tx.ok) {
          bump(counts, entity, tx.reason === 'CONDITION' ? 'matched' : 'errors')
          if (res.invoiceExpected) bump(counts, 'INVOICE', tx.reason === 'CONDITION' ? 'matched' : 'errors')
          if (tx.reason !== 'CONDITION') found('TX_ERROR', tx.message)
          return
        }
      }
      bump(counts, entity, res.outcome)
      if (res.invoiceExpected) bump(counts, 'INVOICE', res.invoice ? 'enriched' : 'matched')
      if (res.bill) {
        bump(counts, 'BILL', 'staged')
        bump(counts, 'BILL', 'enriched')
      }
      return
    }
    const liveLoad = klass === 'LINK' ? existing.loads.get(decision.liveKey)! : null
    const agg = buildLoadAggregate(row, env, liveLoad ? { loadId: liveLoad.id, claimExists: existing.claims.get(decision.liveKey) === liveLoad.id || existing.claims.get(row.proKey as string) === liveLoad.id, hasFinancials: haveFinancials.has(liveLoad.id) } : undefined)
    for (const f of agg.findings) found(f.code, f.detail)
    const invoiceExpected = agg.facts.invoice
    if (invoiceExpected) bump(counts, 'INVOICE', 'staged')
    if (agg.bill) bump(counts, 'BILL', 'staged')
    if (invoiceExpected && !agg.invoice) bump(counts, 'INVOICE', 'conflicts')
    if (klass === 'OWN') {
      const mine = ownRun.get(rowIds(row).shipmentId) === runId
      const outcome = mine ? 'created' : 'matched'
      bump(counts, entity, outcome)
      if (agg.invoice) bump(counts, 'INVOICE', outcome)
      if (agg.bill) bump(counts, 'BILL', outcome)
      return
    }
    const tx = await transactWithRetry(store, agg.items, `${liveLoad ? 'link' : 'load'} ${row.pro}`)
    if (!tx.ok) {
      const raced = liveLoad && tx.reason === 'CONDITION' && tx.failedIndex !== undefined && tx.failedIndex > 0 && agg.items[tx.failedIndex]?.table === 'load'
      if (tx.reason === 'CONDITION' && (tx.failedIndex === 0 || raced)) {
        bump(counts, entity, 'conflicts')
        if (agg.invoice) bump(counts, 'INVOICE', 'conflicts')
        if (agg.bill) bump(counts, 'BILL', 'conflicts')
        found(raced ? 'LINK_RACE' : 'PRO_CLAIMED_ELSEWHERE')
      } else {
        bump(counts, entity, 'errors')
        if (agg.invoice) bump(counts, 'INVOICE', 'errors')
        if (agg.bill) bump(counts, 'BILL', 'errors')
        found('TX_ERROR', tx.message)
      }
      return
    }
    existing.claims.set(row.proKey as string, liveLoad ? liveLoad.id : rowIds(row).loadId)
    if (liveLoad) {
      liveLoad.hasShipment = true
      liveLoad.shipmentId = agg.ids.shipmentId
      liveLoad.orderId = agg.ids.orderId
      found('LINKED_EXISTING_LOAD')
    }
    bump(counts, entity, 'created')
    if (agg.invoice) bump(counts, 'INVOICE', 'created')
    if (agg.bill) bump(counts, 'BILL', 'created')
  })
}

export async function transactWithRetry(store: EngineStore, items: Parameters<EngineStore['transact']>[0], label: string) {
  let result = await store.transact(items, label)
  for (let attempt = 0; !result.ok && result.reason === 'THROTTLED' && attempt < MAX_THROTTLE_RETRIES; attempt++) {
    await sleep(Math.min(4000, 150 * 2 ** attempt))
    result = await store.transact(items, label)
  }
  return result
}

