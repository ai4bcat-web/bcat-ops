/**
 * Pure core of scripts/importCarrierTaxIds.mjs (AW_TAXID_DESIGN.md §4.6/§4.7/§8).
 *
 * Reads the Aljex carriers export's `Fed/SS #` column inside ONE process and hands it to an injected
 * `invoke(rows)` in batches of 100. The value exists only in a local variable for the length of a row and in the
 * in-memory batch: it is never written to a file, a log line, a report or a thrown error, and every result this
 * module returns is a count. Nothing here touches AWS, the filesystem or the console: the caller injects them.
 *
 * Outside production the real value is replaced, before it is batched, by a deterministic synthetic ID derived from
 * the Aljex Carrier ID (EIN prefix 00, SSN area 000: IRS-impossible, so it can never collide with a real number).
 */
import { createHash } from 'node:crypto'
import { createCsvParser } from './csvStream.mjs'

export const BATCH_SIZE = 100
export const TAX_HEADER = 'Fed/SS #'
export const ID_HEADER = 'Aljex Carrier ID'
export const MC_HEADER = 'MC #'
export const DOT_HEADER = 'DOT #'

const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** 'EIN' for NN-NNNNNNN, 'SSN' for NNN-NN-NNNN, 'OTHER' for any other non-empty value, 'EMPTY' for blank. */
export function shapeOf(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return 'EMPTY'
  if (/^\d{2}-\d{7}$/.test(v)) return 'EIN'
  if (/^\d{3}-\d{2}-\d{4}$/.test(v)) return 'SSN'
  return 'OTHER'
}

/** A deterministic IRS-impossible stand-in for one Aljex Carrier ID and shape (EIN: 00-NNNNNNN, SSN: 000-NN-NNNN). */
export function syntheticTaxId(aljexCarrierId, shape) {
  const n = BigInt(`0x${createHash('sha256').update(`taxid-synthetic:${aljexCarrierId}`).digest('hex').slice(0, 12)}`) % 10_000_000n
  const d = n.toString().padStart(7, '0')
  return shape === 'SSN' ? `000-${d.slice(0, 2)}-${d.slice(2, 6)}` : `00-${d}`
}

/** Digits without leading zeros: how MC and DOT are compared everywhere else in the repo. */
export const idKey = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '')

/**
 * @param {object} p
 * @param {AsyncIterable<string>|Iterable<string>} p.chunks the CSV text
 * @param {boolean} p.production real values go to `invoke` only when true
 * @param {boolean} p.apply false = dry run: `invoke` is never called
 * @param {(rows: Array<{aljexCarrierId:string,mcNumber:string,dotNumber:string,value:string}>) => Promise<Record<string, any>>} [p.invoke]
 * @param {{ byMc: Map<string,string>, byDot: Map<string,string>, byAljex: Map<string,string> }} [p.carriers] dry run only
 */
export async function runTaxIdImport({ chunks, production, apply, invoke, carriers }) {
  const out = {
    rows: 0, withValue: 0, shapes: { EIN: 0, SSN: 0, OTHER: 0 }, resolvable: 0, unresolvable: 0,
    batches: 0, set: 0, unchanged: 0, duplicates: 0, invalidFormat: 0, unmatched: 0, skippedInvalid: 0,
  }
  let header = null
  let idx = null
  /** @type {Array<any>} */
  let batch = []
  /** @type {Array<Array<any>>} */
  const ready = []

  const onRow = (cells) => {
    if (!header) {
      header = cells
      const at = (name) => header.findIndex((h) => norm(h) === norm(name))
      idx = { tax: at(TAX_HEADER), id: at(ID_HEADER), mc: at(MC_HEADER), dot: at(DOT_HEADER) }
      if (idx.tax < 0) throw new Error(`the file has no "${TAX_HEADER}" column`)
      if (idx.id < 0) throw new Error(`the file has no "${ID_HEADER}" column`)
      return
    }
    if (cells.every((c) => !String(c).trim())) return
    out.rows++
    const raw = idx.tax < cells.length ? cells[idx.tax] : ''
    const shape = shapeOf(raw)
    if (shape === 'EMPTY') return
    out.withValue++
    out.shapes[shape]++
    const aljexCarrierId = String(cells[idx.id] ?? '').trim()
    const mcNumber = idx.mc >= 0 ? String(cells[idx.mc] ?? '').trim() : ''
    const dotNumber = idx.dot >= 0 ? String(cells[idx.dot] ?? '').trim() : ''

    if (carriers) {
      const hit = (idKey(mcNumber) && carriers.byMc.has(idKey(mcNumber))) || (idKey(dotNumber) && carriers.byDot.has(idKey(dotNumber))) || (aljexCarrierId && carriers.byAljex.has(aljexCarrierId))
      if (hit) out.resolvable++
      else out.unresolvable++
    }
    if (!apply) return
    if (shape === 'OTHER' && !production) { out.skippedInvalid++; return }
    const value = production ? String(raw).trim() : syntheticTaxId(aljexCarrierId, shape)
    batch.push({ aljexCarrierId, mcNumber, dotNumber, value })
    if (batch.length === BATCH_SIZE) { ready.push(batch); batch = [] }
  }

  const flush = async (rows) => {
    out.batches++
    const r = await invoke(rows)
    out.set += Number(r?.set ?? 0)
    out.unchanged += Number(r?.unchanged ?? 0)
    out.invalidFormat += Number(r?.invalidFormat ?? 0)
    out.duplicates += Array.isArray(r?.duplicates) ? r.duplicates.length : Number(r?.duplicates ?? 0)
    out.unmatched += Array.isArray(r?.unmatched) ? r.unmatched.length : Number(r?.unmatched ?? 0)
  }

  const parser = createCsvParser(onRow)
  for await (const chunk of chunks) {
    parser.write(chunk)
    while (ready.length) await flush(ready.shift())
  }
  parser.end()
  while (ready.length) await flush(ready.shift())
  if (batch.length) { const last = batch; batch = []; await flush(last) }
  return out
}
