/**
 * STAGE: parse the source once (streaming, quote-aware, ragged-tolerant), classify every row, write the
 * canonical rows as JSONL chunks plus the derived masters and the summary the router shows.
 *
 * Output (all under `imports/jobs/<rootJobId>/`): `rows-<n>.jsonl`, `stage-index.json`,
 * `masters.json`, `stage-summary.json`. Nothing here writes entity tables.
 */
import { createHash } from 'node:crypto'
import type { AljexImportJob, AljexStageSummary, DistinctValueCount, EngineStore } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { classifyRow, rowFindings, rowSignature } from '../../../../src/lib/aljex/classify'
import { createByteDecoder, createCsvParser, sniffDelimiter, type CsvParser } from '../../../../src/lib/aljex/csv'
import { addMonths, derivedWindow, isPlausibleDate, type DateWindow } from '../../../../src/lib/aljex/dates'
import { detectLayout, UnknownLayoutError, type AljexLayout } from '../../../../src/lib/aljex/layout'
import { mapAljexRow } from '../../../../src/lib/aljex/mapRow'
import { findUnmapped, type DistinctValues } from '../../../../src/lib/aljex/profile'
import { findSensitiveHeaders, SENSITIVE_COLUMNS_MESSAGE } from '../../../../src/lib/aljex/sensitiveColumns'
import { rowFacts } from './facts'
import { resolveStagedMemos } from './memos'
import { loadProfile } from './profileLoad'
import { bump, type Counts, type Finding, type MasterCarrier, type MasterCustomer, type StageIndex, type StagedMasters } from './types'
import { readAll } from './util'

export const ROWS_PER_CHUNK = 500
/** Step AW (R19/R20): history older than this many months before the cutoff is not imported. */
export const HISTORY_MONTHS = 24
const MAX_FINDINGS = 20_000

export const stageKey = (root: string, name: string): string => `imports/jobs/${root}/${name}`

/** The Chicago calendar day of an instant (TmsSettings.aljexCutoffAt is 00:00 America/Chicago). */
function chicagoDay(iso: string): string | null {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
}

/** The cutoff day: the job's explicit `cutoffDate`, else `TmsSettings.aljexCutoffAt`; null = no history window. */
async function resolveCutoff(store: EngineStore, job: AljexImportJob): Promise<string | null> {
  if (typeof job.options?.cutoffDate === 'string' && job.options.cutoffDate) return job.options.cutoffDate
  const [settings] = await store.getMany('settings', ['default'])
  return typeof settings?.aljexCutoffAt === 'string' && settings.aljexCutoffAt ? chicagoDay(settings.aljexCutoffAt) : null
}
export const chunkKey = (root: string, n: number): string => stageKey(root, `rows-${String(n).padStart(4, '0')}.jsonl`)

export interface StageData {
  index: StageIndex & { stageCounts: Counts; distinct: DistinctValues; syntheticOk: boolean; maxProNumber: number }
  masters: StagedMasters
}

export async function readJson<T>(store: EngineStore, key: string): Promise<T> {
  return JSON.parse(await readAll(store.getObject(key))) as T
}

export async function readStageData(store: EngineStore, root: string): Promise<StageData> {
  const [index, masters] = await Promise.all([
    readJson<StageData['index']>(store, stageKey(root, 'stage-index.json')),
    readJson<StagedMasters>(store, stageKey(root, 'masters.json')),
  ])
  return { index, masters }
}

export async function readChunk(store: EngineStore, root: string, n: number): Promise<CanonicalRow[]> {
  const text = await readAll(store.getObject(chunkKey(root, n)))
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CanonicalRow)
}

function countValues(map: Map<string, number>): DistinctValueCount[] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, count }))
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const entityOf = (row: CanonicalRow) => row.kind

export async function runStage(store: EngineStore, job: AljexImportJob, root: string): Promise<{ stageHash: string; summary: AljexStageSummary; rows: number }> {
  const { profile } = await loadProfile(store, job)
  const cutoff = await resolveCutoff(store, job)
  const windowStart = cutoff ? addMonths(cutoff, -HISTORY_MONTHS) : null
  const historySkipped: string[] = []
  let beforeWindow = 0
  let afterCutoff = 0
  let newestAnyPro = 0
  const sourceKey = typeof job.options?.sourceKey === 'string' ? job.options.sourceKey : `imports/source/${root}/${job.fileName ?? ''}`
  const sliceEvery = typeof job.options?.sliceEvery === 'number' && job.options.sliceEvery > 1 ? job.options.sliceEvery : null

  const hasher = createHash('sha256')
  const decoder = createByteDecoder()
  let parser: CsvParser | null = null
  let pending = ''
  let headers: string[] | null = null
  let layout: AljexLayout | null = null
  let rowNumber = 0
  let raggedRows = 0
  let blankRows = 0
  let layoutError: string | null = null

  let syntheticOk = true
  const rows: CanonicalRow[] = []
  const stageCounts: Counts = {}
  const findings: Finding[] = []
  const stagedSkips: Record<string, number> = {}
  const seen = new Map<string, { sig: string; rowNumber: number }>()
  const find = (f: Finding) => {
    if (findings.length < MAX_FINDINGS) findings.push(f)
  }

  const onRow = (cells: string[]) => {
    if (!headers) {
      headers = cells
      const sensitive = findSensitiveHeaders(cells)
      if (sensitive.length) throw new Error(`${SENSITIVE_COLUMNS_MESSAGE} Columns: ${sensitive.join(', ')}`)
      try {
        layout = detectLayout(cells)
      } catch (err) {
        layoutError = err instanceof UnknownLayoutError ? err.message : String(err)
        throw err
      }
      return
    }
    if (cells.every((c) => c.trim() === '')) {
      blankRows += 1
      return
    }
    rowNumber += 1
    if (sliceEvery && (rowNumber - 1) % sliceEvery !== 0) return
    if (cells.length < layout!.headerCount) raggedRows += 1
    const row = mapAljexRow(cells, layout!, { rowNumber, profile })
    const cls = classifyRow(row)
    if (cls === 'JUNK') {
      stagedSkips.JUNK_ROW = (stagedSkips.JUNK_ROW ?? 0) + 1
      find({ code: 'JUNK_ROW', rowNumber })
      return
    }
    const entity = entityOf(row)
    bump(stageCounts, entity, 'staged')
    // Judged on every row of the file, including the ones rejected below.
    syntheticOk &&= /^\d+$/.test(row.proKey ?? row.pro) && Number(row.proKey ?? row.pro) >= 900000 && Number(row.proKey ?? row.pro) <= 999999
    syntheticOk &&= (row.customer.name === '' || row.customer.name.startsWith('ZZ ')) && (!row.carrier || row.carrier.name === '' || row.carrier.name.startsWith('ZZ '))
    const fs = rowFindings(row, profile)
    for (const f of fs) if (f.outcome === 'warning') find({ code: f.code, pro: row.pro, rowNumber, detail: f.column })
    for (const j of row.junkDates) find({ code: 'JUNK_DATE', pro: row.pro, rowNumber, detail: j.column })
    const errs = fs.filter((f) => f.outcome === 'error')
    if (errs.length) {
      bump(stageCounts, entity, 'errors')
      for (const e of errs) find({ code: e.code, pro: row.pro, rowNumber, detail: e.column })
      return
    }
    const conflicts = fs.filter((f) => f.outcome === 'conflict')
    if (conflicts.length) {
      bump(stageCounts, entity, 'conflicts')
      for (const c of conflicts) find({ code: c.code, pro: row.pro, rowNumber })
      return
    }
    // The numbering floor must clear every PRO the file names, in or out of the window.
    if (/^\d{1,9}$/.test(row.proKey ?? '') && (Number(row.proKey) < 900000 || Number(row.proKey) > 999999)) newestAnyPro = Math.max(newestAnyPro, Number(row.proKey))
    const key = row.proKey as string
    const prior = seen.get(key)
    const sig = createHash('sha1').update(rowSignature(cells)).digest('hex')
    if (prior) {
      if (prior.sig === sig) {
        bump(stageCounts, entity, 'skipped')
        stagedSkips.DUPLICATE_ROW_IDENTICAL = (stagedSkips.DUPLICATE_ROW_IDENTICAL ?? 0) + 1
        find({ code: 'DUPLICATE_ROW_IDENTICAL', pro: row.pro, rowNumber, detail: `first row ${prior.rowNumber}` })
      } else {
        bump(stageCounts, entity, 'conflicts')
        find({ code: 'DUPLICATE_PRO_CONFLICT', pro: row.pro, rowNumber, detail: `first row ${prior.rowNumber}` })
      }
      return
    }
    seen.set(key, { sig, rowNumber })
    const ship = row.kind === 'LOAD' && /^\d{4}-\d{2}-\d{2}$/.test(row.dates.ship ?? '') ? (row.dates.ship as string) : null
    if (cutoff && windowStart && ship && (ship < windowStart || ship >= cutoff)) {
      const before = ship < windowStart
      if (before) beforeWindow += 1
      else afterCutoff += 1
      bump(stageCounts, entity, 'skipped')
      const code = before ? 'HISTORY_BEFORE_WINDOW' : 'AFTER_CUTOFF'
      stagedSkips[code] = (stagedSkips[code] ?? 0) + 1
      historySkipped.push(`${row.pro},${ship},${before ? 'BEFORE_WINDOW' : 'AFTER_CUTOFF'}`)
      return
    }
    rows.push(row)
  }

  const feed = (text: string) => {
    if (!text) return
    if (parser) {
      parser.write(text)
      return
    }
    pending += text
    const nl = pending.search(/[\r\n]/)
    if (nl < 0) return
    parser = createCsvParser(onRow, { delimiter: sniffDelimiter(pending.slice(0, nl)) })
    parser.write(pending)
    pending = ''
  }

  try {
    for await (const chunk of store.getObject(sourceKey)) {
      hasher.update(chunk)
      feed(decoder.write(chunk))
    }
    feed(decoder.end())
    if (!parser && pending) {
      parser = createCsvParser(onRow, { delimiter: sniffDelimiter(pending) })
      parser.write(pending)
    }
    parser?.end()
  } catch (err) {
    if (layoutError) {
      // ES2020 lib has no ErrorOptions constructor: attach the cause explicitly.
      const refused = new Error(`The file does not match a known Aljex layout: ${layoutError}`)
      ;(refused as Error & { cause?: unknown }).cause = err
      throw refused
    }
    throw err
  }
  if (!layout) throw new Error('The file has no header row')

  const sha = hasher.digest('hex')
  if (job.fileHash && job.fileHash !== sha) throw new Error('FILE_HASH_MISMATCH: the uploaded file does not match the hash computed in the browser')
  const stageHash = sliceEvery ? `${sha}:slice${sliceEvery}` : sha

  // ── window, masters, distinct values ───────────────────────────────────────────────────────
  const window: DateWindow = profile.window ?? derivedWindow(rows.map((r) => r.dates.created)) ?? { start: '2000-01-01', end: '2035-12-31' }
  const distinct = { status: new Map<string, number>(), type: new Map<string, number>(), rating: new Map<string, number>(), marker: new Map<string, number>(), rep: new Map<string, number>(), disp: new Map<string, number>() }
  const custAcc = new Map<string, { names: Map<string, { n: number; latest: string }>; last: CanonicalRow; lastShip: string | null; rows: number; lead: { v: string; at: string } }>()
  const carAcc = new Map<string, MasterCarrier>()
  let newestShip: string | null = null
  let maxProNumber = 0

  for (const row of rows) {
    if (row.kind === 'LOAD') {
      inc(distinct.status, row.statusKey)
      inc(distinct.type, row.typeOfShipment.toUpperCase())
      if (row.carrier) inc(distinct.rating, row.carrier.safetyRating)
      if (row.salesrepId) inc(distinct.rep, row.salesrepId)
      for (const d of [row.staff.assignedDispatcher, row.staff.actualDispatcher]) if (d) inc(distinct.disp, d)
    }
    for (const s of row.stops) if (s.marker) inc(distinct.marker, s.marker)
    const ship = isPlausibleDate(row.dates.ship, window) ? row.dates.ship : null
    if (row.kind === 'LOAD' && ship && (!newestShip || ship > newestShip)) newestShip = ship
    if (/^\d{1,9}$/.test(row.proKey ?? '')) {
      const n = Number(row.proKey)
      if (n < 900000 || n > 999999) maxProNumber = Math.max(maxProNumber, n)
    }

    const acc = row.customer.account
    if (acc) {
      let c = custAcc.get(acc)
      if (!c) custAcc.set(acc, (c = { names: new Map(), last: row, lastShip: null, rows: 0, lead: { v: '', at: '' } }))
      c.rows += 1
      if (row.leadSource && (row.dates.created ?? '') >= c.lead.at) c.lead = { v: row.leadSource, at: row.dates.created ?? '' }
      const nm = row.customer.name
      if (nm) {
        const e = c.names.get(nm) ?? { n: 0, latest: '' }
        e.n += 1
        e.latest = (row.dates.created ?? '') > e.latest ? (row.dates.created as string) : e.latest
        c.names.set(nm, e)
      }
      if ((row.dates.created ?? '') >= (c.last.dates.created ?? '')) c.last = row
      if (ship && (!c.lastShip || ship > c.lastShip)) c.lastShip = ship
    }
  }

  const customers: MasterCustomer[] = [...custAcc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, c]) => {
      const ranked = [...c.names.entries()].sort(([an, a], [bn, b]) => b.n - a.n || b.latest.localeCompare(a.latest) || an.localeCompare(bn))
      const p = c.last.customer
      return { account, name: ranked[0]?.[0] ?? p.name, aliases: ranked.slice(1).map(([n]) => n), street: p.street, city: p.city, state: p.state, zip: p.zip, contact: p.contact, lastShip: c.lastShip, leadSource: c.lead.v, rows: c.rows }
    })

  for (const row of rows) {
    if (row.kind !== 'LOAD' || !row.carrier || !row.carrier.id) continue
    const f = rowFacts(row, profile, window)
    const car = row.carrier
    let m = carAcc.get(car.id)
    if (!m) {
      m = { id: car.id, name: car.name, names: [], mc: car.mc, mcPrefix: car.mcPrefix, dot: car.dot, scac: car.scac, safetyRating: car.safetyRating, phone: car.phone, email: car.email, dispatcher: car.dispatcher, dispatchPhone: car.dispatchPhone, loads: 0, newestShip: null, openBill: false, inFlight: false, costCents: 0, ownAsset: f.ownAsset, caIntrastate: car.caIntrastate, caIntrastateExp: car.caIntrastateExp, txPuc: car.txPuc, txPucExp: car.txPucExp }
      carAcc.set(car.id, m)
    }
    if (car.name && car.name !== m.name && !m.names.includes(car.name)) m.names.push(car.name)
    m.mc ||= car.mc
    m.mcPrefix ||= car.mcPrefix
    m.dot ||= car.dot
    m.scac ||= car.scac
    m.phone ||= car.phone
    m.email ||= car.email
    m.dispatcher ||= car.dispatcher
    m.dispatchPhone ||= car.dispatchPhone
    m.safetyRating ||= car.safetyRating
    m.caIntrastate ||= car.caIntrastate
    m.txPuc ||= car.txPuc
    if (car.caIntrastateExp && (!m.caIntrastateExp || car.caIntrastateExp > m.caIntrastateExp)) m.caIntrastateExp = car.caIntrastateExp
    if (car.txPucExp && (!m.txPucExp || car.txPucExp > m.txPucExp)) m.txPucExp = car.txPucExp
    m.loads += 1
    const ship = isPlausibleDate(row.dates.ship, window) ? row.dates.ship : null
    if (ship && (!m.newestShip || ship > m.newestShip)) m.newestShip = ship
    if (f.ap && f.ap.balanceCents > 0) m.openBill = true
    if (f.status.entry.inFlight && !f.isVoid) m.inFlight = true
    m.costCents += f.ap?.carrierTotalCents ?? row.money.projectedCarrierExpenseCents
  }
  const carriers = [...carAcc.values()].sort((a, b) => a.id.localeCompare(b.id))

  // ── chunks ─────────────────────────────────────────────────────────────────────────────────
  const chunkCount = Math.ceil(rows.length / ROWS_PER_CHUNK)
  for (let n = 0; n < chunkCount; n++) {
    const body = rows.slice(n * ROWS_PER_CHUNK, (n + 1) * ROWS_PER_CHUNK).map((r) => JSON.stringify(r)).join('\n')
    await store.putObject(chunkKey(root, n), `${body}\n`)
  }

  const distinctValues: DistinctValues = {
    status: [...distinct.status.keys()],
    typeOfShipment: [...distinct.type.keys()],
    safetyRating: [...distinct.rating.keys()],
    stopMarkers: [...distinct.marker.keys()],
    salesreps: [...distinct.rep.keys()],
    dispatchers: [...distinct.disp.keys()],
  }
  const memos = rows.filter((r) => r.kind !== 'LOAD').length
  const index: StageData['index'] = {
    stageHash,
    layoutId: (layout as AljexLayout).id,
    rows: rowNumber,
    loads: rows.length - memos,
    memos,
    junkDates: rows.reduce((n, r) => n + r.junkDates.length, 0),
    duplicatePros: stagedSkips.DUPLICATE_ROW_IDENTICAL ?? 0,
    raggedRows,
    parseErrors: Object.values(stageCounts).reduce((n, c) => n + (c?.errors ?? 0), 0),
    chunkCount,
    rowsPerChunk: ROWS_PER_CHUNK,
    findings,
    stagedSkips: { ...stagedSkips, ...(blankRows ? { BLANK_ROW: blankRows } : {}) },
    stageCounts,
    distinct: distinctValues,
    syntheticOk: syntheticOk && rowNumber > 0,
    maxProNumber: Math.max(maxProNumber, newestAnyPro),
    history: { cutoffDate: cutoff, windowStart, beforeWindow, afterCutoff },
  }
  const memoIndex = resolveStagedMemos(rows, profile, window)
  const masters: StagedMasters = { customers, carriers, memos: memoIndex, newestShip, window, chunkCount, rowsPerChunk: ROWS_PER_CHUNK }
  if (cutoff) await store.putObject(stageKey(root, 'history-skipped.csv'), `pro,ship_date,reason\n${historySkipped.join('\n')}${historySkipped.length ? '\n' : ''}`)
  await store.putObject(stageKey(root, 'masters.json'), JSON.stringify(masters))
  await store.putObject(stageKey(root, 'stage-index.json'), JSON.stringify(index))

  const unmappedCounts = (col: Map<string, number>, column: string) =>
    findUnmapped(profile, { status: [], typeOfShipment: [], safetyRating: [], stopMarkers: [], salesreps: [], dispatchers: [], ...{ [column]: [...col.keys()] } }).map((u) => ({ column: u.column, value: u.value, count: col.get(u.value) ?? 0 }))
  const unmapped = [
    ...unmappedCounts(distinct.status, 'status'),
    ...unmappedCounts(distinct.type, 'typeOfShipment'),
    ...unmappedCounts(distinct.rating, 'safetyRating'),
    ...unmappedCounts(distinct.marker, 'stopMarkers'),
    ...unmappedCounts(distinct.rep, 'salesreps'),
    ...unmappedCounts(distinct.disp, 'dispatchers'),
  ]
  const summary: AljexStageSummary = {
    rows: index.rows,
    loads: index.loads,
    memos: index.memos,
    junkDates: index.junkDates,
    duplicatePros: index.duplicatePros,
    raggedRows,
    parseErrors: index.parseErrors,
    layoutMatches: true,
    distinct: {
      status: countValues(distinct.status),
      typeOfShipment: countValues(distinct.type),
      safetyRating: countValues(distinct.rating),
      stopMarkers: countValues(distinct.marker),
      salesreps: countValues(distinct.rep),
      dispatchers: countValues(distinct.disp),
    },
    unmapped,
  }
  await store.putObject(stageKey(root, 'stage-summary.json'), JSON.stringify(summary))
  return { stageHash, summary, rows: rowNumber }
}

/** Anchor of the carrier activity window: the explicit cutoff or the file's newest plausible ship date (DECIDED-7). */
export function carrierWindowStart(masters: StagedMasters, cutoff: string | null, months: number): string | null {
  const anchor = cutoff ?? masters.newestShip
  return anchor ? addMonths(anchor, -months) : null
}
