/**
 * Builds one reconciliation report (Step AW E.2): reads the Aljex side (the staged full export for AR / shipments, the
 * uploaded master file for customers / carriers / AP aging) and the BCAT side (the tables this stack holds), and hands
 * both to the pure comparison in `src/lib/aljexReconcile.ts`. Writes nothing; the router stores the result.
 *
 * Sensitive columns are never read: each file reader names the few columns it wants.
 */
import type { AljexImportJob, EngineStore } from '../../../src/types/tms'
import { createCsvParser } from '../../../src/lib/aljex/csv'
import type { CanonicalRow } from '../../../src/lib/aljex/canonical'
import {
  apAgingReader,
  arItemsFromCanonical,
  assembleReport,
  bcatBillItems,
  bcatCarrierRows,
  bcatCustomerRows,
  bcatInvoiceItems,
  bcatLocationRows,
  bcatShipmentRows,
  carriersReader,
  compareLedger,
  compareRecords,
  customersReader,
  FIELD_SPECS,
  historyWindow,
  shipmentSideFromCanonical,
  withBcatFileBuckets,
  type CanonicalFacts,
  type ReconCounts,
  type ReconDiff,
  type ReconEntity,
  type ReconReport,
  type SideReader,
} from '../../../src/lib/aljexReconcile'
import { scanRows } from './engine/directory'
import { rowFacts } from './engine/facts'
import { loadProfile } from './engine/profileLoad'
import { rootJobIdOf } from './engine/report'
import { readChunk, readStageData } from './engine/stage'

export interface ReconIo {
  streamText: (key: string) => AsyncIterable<string>
}

export interface ReconParams {
  entity: ReconEntity
  /** The import job whose staged data / uploaded file is the Aljex side. */
  source: AljexImportJob
  /** Optional customers-master job: its Invoice Terms Days give the Aljex side of the AR due dates. */
  customersJob: AljexImportJob | null
  asOf: string
  cutoffDate: string
  generatedAt: string
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

async function readFile(io: ReconIo, store: EngineStore, job: AljexImportJob, reader: SideReader): Promise<void> {
  if (!job.fileName) throw new Error(`Job ${job.id} has no uploaded file`)
  const root = await rootJobIdOf(store, job)
  const key = `imports/source/${root}/${job.fileName}`
  let failure: unknown = null
  const parser = createCsvParser((cells) => {
    if (failure) return
    try {
      reader.push(cells)
    } catch (err) {
      failure = err
    }
  })
  for await (const chunk of io.streamText(key)) {
    parser.write(chunk)
    if (failure) break
  }
  if (!failure) parser.end()
  if (failure) throw failure
}

async function stagedRows(store: EngineStore, source: AljexImportJob): Promise<{ rows: CanonicalRow[]; facts: (r: CanonicalRow) => CanonicalFacts }> {
  const root = await rootJobIdOf(store, source)
  const stage = await readStageData(store, root)
  const { profile } = await loadProfile(store, source)
  const rows: CanonicalRow[] = []
  for (let c = 0; c < stage.masters.chunkCount; c++) rows.push(...(await readChunk(store, root, c)))
  const window = stage.masters.window
  const facts = (r: CanonicalRow): CanonicalFacts => {
    const f = rowFacts(r, profile, window)
    return { hasInvoice: f.invoice, isVoid: f.isVoid, shipmentStatus: f.shipmentStatus }
  }
  return { rows, facts }
}

async function defaultTerms(store: EngineStore): Promise<number | null> {
  const [settings] = await store.getMany('settings', ['default'])
  return typeof settings?.defaultPaymentTermsDays === 'number' ? settings.defaultPaymentTermsDays : null
}

export async function buildReconReport(store: EngineStore, io: ReconIo, p: ReconParams): Promise<ReconReport> {
  const notes: string[] = []
  const base = { entity: p.entity, generatedAt: p.generatedAt, asOf: p.asOf, sourceJobId: p.source.id }
  const terms = await defaultTerms(store)

  if (p.entity === 'CUSTOMERS') {
    const reader = customersReader()
    await readFile(io, store, p.source, reader)
    const side = reader.finish()
    const inactive = reader.inactive()
    const customers = await scanRows(store, 'customer', ['id', 'name', 'aljexCode', 'active', 'paymentTermsDays', 'billingMethod', 'apEmail', 'billingEmail', 'contactEmail', 'mergedIntoId'])
    const locations = await scanRows(store, 'location', ['id', 'name', 'aljexCode'])
    const active = compareRecords(side.rows, bcatCustomerRows(customers, terms), FIELD_SPECS.CUSTOMERS!)
    // An inactive Aljex customer is a Location in BCAT: present or missing, nothing else to compare, and BCAT Locations
    // with no Aljex counterpart are not differences of this report.
    const loc = compareRecords(inactive, bcatLocationRows(locations), [{ field: 'name', label: 'Name', kind: 'text' }])
    const locDiffs = loc.diffs.filter((d) => d.kind !== 'BCAT_ONLY')
    const diffs: ReconDiff[] = [...active.diffs, ...locDiffs]
    const counts: ReconCounts = {
      aljexRows: active.counts.aljexRows + loc.counts.aljexRows,
      bcatRows: active.counts.bcatRows,
      matched: active.counts.matched + loc.counts.matched,
      aljexOnly: active.counts.aljexOnly + loc.counts.aljexOnly,
      bcatOnly: active.counts.bcatOnly,
      mismatched: active.counts.mismatched + loc.counts.mismatched,
      diffs: diffs.length,
    }
    return assembleReport({ ...base, diffs, counts, money: null, excluded: side.excluded, notes: [...side.notes, ...notes] })
  }

  if (p.entity === 'CARRIERS') {
    const reader = carriersReader()
    await readFile(io, store, p.source, reader)
    const side = reader.finish()
    const carriers = await scanRows(store, 'carrier', ['id', 'name', 'aljexCode', 'aljexAliases', 'mcNumber', 'dotNumber', 'status', 'paymentTermsDays', 'quickPayEligible', 'defaultQuickPayDays', 'factorPaymentMethodId'])
    const r = compareRecords(side.rows, bcatCarrierRows(carriers, terms), FIELD_SPECS.CARRIERS!)
    return assembleReport({ ...base, ...r, money: null, excluded: side.excluded, notes })
  }

  if (p.entity === 'AP') {
    const reader = apAgingReader(p.asOf)
    await readFile(io, store, p.source, reader)
    const side = reader.finish()
    const carrierNames = new Map<string, string>()
    for (const c of await scanRows(store, 'carrier', ['id', 'name'])) carrierNames.set(text(c.id), text(c.name))
    const bills = bcatBillItems(await scanRows(store, 'carrierBill', ['id', 'billNumber', 'carrierId', 'carrierName', 'balanceCents', 'apOpen', 'dueAt']), carrierNames)
    const r = compareLedger('AP', side.ledger ?? [], bills, p.asOf, withBcatFileBuckets(side.fileBuckets ?? [], bills, p.asOf))
    notes.push("'Amount Paid' in the AP aging file is the bill amount (the bills are unpaid); the open amount is the five aging columns.")
    return assembleReport({ ...base, ...r, excluded: side.excluded, notes })
  }

  // AR and shipments read the staged full export.
  const { rows, facts } = await stagedRows(store, p.source)

  if (p.entity === 'AR') {
    const customerTerms = new Map<string, number | null>()
    if (p.customersJob) {
      const reader = customersReader()
      await readFile(io, store, p.customersJob, reader)
      for (const row of [...reader.finish().rows, ...reader.inactive()]) customerTerms.set(row.key, (row.fields.termsDays as number | null) ?? null)
      notes.push('Aljex due dates use the Invoice Terms Days of the customers file.')
    } else {
      for (const c of await scanRows(store, 'customer', ['aljexCode', 'paymentTermsDays'])) {
        if (text(c.aljexCode)) customerTerms.set(text(c.aljexCode), typeof c.paymentTermsDays === 'number' ? c.paymentTermsDays : null)
      }
      notes.push('The export has no terms column: Aljex due dates use the BCAT customer terms (pass a customers file to use the Aljex ones).')
    }
    const ar = arItemsFromCanonical(rows, facts, { customerTermsDays: (a) => customerTerms.get(a) ?? null, orgDefaultTermsDays: terms })
    const invoices = bcatInvoiceItems(await scanRows(store, 'invoice', ['id', 'number', 'customerName', 'balanceCents', 'arOpen', 'dueAt']))
    const r = compareLedger('AR', ar.items, invoices, p.asOf)
    return assembleReport({ ...base, ...r, excluded: ar.excluded, notes })
  }

  const window = historyWindow(p.cutoffDate)
  const side = shipmentSideFromCanonical(rows, facts, window)
  const shipments = await scanRows(store, 'shipment', ['id', 'number', 'status', 'customerName', 'voidedAt'])
  const ordersByShipment = new Map<string, Record<string, unknown>>()
  for (const o of await scanRows(store, 'order', ['id', 'shipmentId', 'customerRateCents'])) ordersByShipment.set(text(o.shipmentId), o)
  const legs = new Map<string, Record<string, unknown>[]>()
  for (const l of await scanRows(store, 'loadCarrier', ['id', 'shipmentId', 'status', 'carrierName', 'costCents', 'carrierRateCents'])) {
    const k = text(l.shipmentId)
    legs.set(k, [...(legs.get(k) ?? []), l])
  }
  const r = compareRecords(side.rows, bcatShipmentRows(shipments, ordersByShipment, legs), FIELD_SPECS.SHIPMENTS!)
  notes.push(`Aljex rows are limited to ship dates ${window.start} to ${window.end} (24 months before the ${p.cutoffDate} cutoff).`)
  return assembleReport({ ...base, ...r, money: null, excluded: side.excluded, notes })
}
