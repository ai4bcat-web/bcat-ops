/**
 * P4: one transaction per PRO. Classifies each staged row against the target (CREATE / OWN / ENRICH /
 * UNLINKED / CONFLICT), writes the final aggregate, and keeps the outcome counters the conservation
 * invariant is asserted on. The same code runs against the overlay store for PLAN.
 */
import type { AljexImportJob, EngineStore } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import type { AljexProfile } from '../../../../src/lib/aljex/profile'
import { normalizePro } from '../../../../src/lib/proNumber'
import { buildLoadAggregate, buildMemoRow, rowIds, type LoadEnv } from './aggregate'
import { loadCarrierLookup, loadCustomerLookup, loadLocationMaps, scanRows, text } from './directory'
import { buildEnrich, type ExistingLoad } from './enrich'
import { readChunk, type StageData } from './stage'
import { bump, type Counts, type Finding } from './types'
import { sleep } from './util'

export interface ExistingIndex {
  claims: Map<string, string>
  loads: Map<string, ExistingLoad & { hasShipment: boolean }>
}

export async function loadExistingIndex(store: EngineStore): Promise<ExistingIndex> {
  const claims = new Map<string, string>()
  for (const c of await scanRows(store, 'proClaim', ['id', 'loadId'])) claims.set(text(c.id), text(c.loadId))
  const loads = new Map<string, ExistingLoad & { hasShipment: boolean }>()
  for (const l of await scanRows(store, 'load', ['id', 'aljexId', 'shipmentId', 'orderId', 'activeLoadCarrierId'])) {
    const key = normalizePro(text(l.aljexId))
    if (!key) continue
    loads.set(key, { id: text(l.id), shipmentId: text(l.shipmentId), orderId: text(l.orderId), activeLoadCarrierId: text(l.activeLoadCarrierId), hasShipment: Boolean(text(l.shipmentId)) })
  }
  return { claims, loads }
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
  const cls = (r: CanonicalRow) => {
    const ids = rowIds(r)
    const claim = existing.claims.get(r.proKey as string)
    if (claim === ids.loadId) return 'OWN' as const
    const live = existing.loads.get(r.proKey as string)
    if (live) return live.hasShipment ? ('ENRICH' as const) : ('UNLINKED' as const)
    return claim ? ('CONFLICT' as const) : ('CREATE' as const)
  }
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
    const klass = cls(row)
    if (klass === 'CONFLICT') {
      bump(counts, entity, 'conflicts')
      found('PRO_CLAIMED_ELSEWHERE')
      return
    }
    if (klass === 'UNLINKED') {
      bump(counts, entity, 'skipped')
      found('UNLINKED_EXISTING')
      return
    }
    if (klass === 'ENRICH') {
      const live = existing.loads.get(row.proKey as string)!
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
    const agg = buildLoadAggregate(row, env)
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
    const tx = await transactWithRetry(store, agg.items, `load ${row.pro}`)
    if (!tx.ok) {
      if (tx.reason === 'CONDITION' && tx.failedIndex === 0) {
        bump(counts, entity, 'conflicts')
        if (agg.invoice) bump(counts, 'INVOICE', 'conflicts')
        if (agg.bill) bump(counts, 'BILL', 'conflicts')
        found('PRO_CLAIMED_ELSEWHERE')
      } else {
        bump(counts, entity, 'errors')
        if (agg.invoice) bump(counts, 'INVOICE', 'errors')
        if (agg.bill) bump(counts, 'BILL', 'errors')
        found('TX_ERROR', tx.message)
      }
      return
    }
    existing.claims.set(row.proKey as string, rowIds(row).loadId)
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

