/**
 * ACTIVE_SHIPMENTS layout: the Aljex "active shipments" report (10 rows on 2026-11-08). No writes anywhere: it is the
 * first end-to-end cross-check. Each PRO must exist in BCAT with the same customer, carrier, rates and stops;
 * differences go to the reconciliation screen.
 *
 * Pure: `parseActiveShipments` reads the file, `compareActiveShipment` compares one row with a snapshot of the BCAT side
 * (the engine builds the snapshot from the Load / LoadFinancials / LoadCarrier rows).
 */
import { parseAljexDate } from '../dates'
import { parseMoney } from '../money'
import { normalizePro } from '../../proNumber'
import { cell, LayoutHeaderError, nameKey, optionalHeader, parseCsvRows, resolveHeaders, type LayoutFinding } from './apAging'

export const ACTIVE_SHIPMENTS_LAYOUT_ID = 'aljex-active-shipments-v1'

export interface ActiveShipmentRow {
  rowNumber: number
  proKey: string
  pro: string
  status: string
  customerName: string
  /** Blank when no carrier is booked yet (an OPEN shipment). */
  carrierName: string
  customerRateCents: number
  carrierRateCents: number
  firstStopName: string
  /** `City, ST` as Aljex prints it. */
  firstStopCity: string
  firstStopZip: string
  firstStopDate: string | null
  lastStopName: string
  lastStopCity: string
  lastStopZip: string
}

export interface ActiveShipmentsParse {
  layoutId: typeof ACTIVE_SHIPMENTS_LAYOUT_ID
  rows: number
  shipments: ActiveShipmentRow[]
  duplicates: ActiveShipmentRow[]
  rejected: Array<{ rowNumber: number; reason: string }>
  findings: LayoutFinding[]
}

const REQUIRED = {
  pro: 'shipment_pro',
  status: 'shipment_status',
  customer: 'customer name',
  carrier: 'carrier name',
  customerRate: 'shipment_customer_total_rates',
  carrierRate: 'shipment_carrier_total_rates',
  firstName: 'pick_stop_1_name',
  firstCity: 'pickup',
  lastName: 'pick_stop_last_name',
  lastCity: 'consignee',
} as const

export function parseActiveShipments(rows: string[][]): ActiveShipmentsParse {
  if (rows.length === 0) throw new LayoutHeaderError(ACTIVE_SHIPMENTS_LAYOUT_ID, 'MISSING_COLUMNS', Object.values(REQUIRED))
  const header = rows[0]
  const c = resolveHeaders(ACTIVE_SHIPMENTS_LAYOUT_ID, header, REQUIRED)
  const firstZip = optionalHeader(header, 'pick_stop_1_location_zip')
  const lastZip = optionalHeader(header, 'pick_stop_last_location_zip')
  const firstDate = optionalHeader(header, 'pick_stop_1_ready_or_deliver_date')
  const out: ActiveShipmentsParse = { layoutId: ACTIVE_SHIPMENTS_LAYOUT_ID, rows: rows.length - 1, shipments: [], duplicates: [], rejected: [], findings: [] }
  const seen = new Set<string>()
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNumber = i + 1
    const pro = cell(r, c.pro)
    const proKey = normalizePro(pro)
    if (!proKey) {
      out.rejected.push({ rowNumber, reason: 'PRO missing' })
      out.findings.push({ code: 'ACTIVE_ROW_REJECTED', rowNumber, pro, detail: 'PRO missing' })
      continue
    }
    const row: ActiveShipmentRow = {
      rowNumber,
      proKey,
      pro,
      status: cell(r, c.status),
      customerName: cell(r, c.customer),
      carrierName: cell(r, c.carrier),
      customerRateCents: parseMoney(cell(r, c.customerRate)).cents ?? 0,
      carrierRateCents: parseMoney(cell(r, c.carrierRate)).cents ?? 0,
      firstStopName: cell(r, c.firstName),
      firstStopCity: cell(r, c.firstCity),
      firstStopZip: cell(r, firstZip),
      firstStopDate: parseAljexDate(cell(r, firstDate)).date,
      lastStopName: cell(r, c.lastName),
      lastStopCity: cell(r, c.lastCity),
      lastStopZip: cell(r, lastZip),
    }
    if (seen.has(proKey)) {
      out.duplicates.push(row)
      out.findings.push({ code: 'ACTIVE_DUPLICATE_PRO', rowNumber, pro })
      continue
    }
    seen.add(proKey)
    out.shipments.push(row)
  }
  return out
}

export const parseActiveShipmentsCsv = (text: string): ActiveShipmentsParse => parseActiveShipments(parseCsvRows(text))

/** What the BCAT side of one PRO looks like. */
export interface BcatShipmentSnapshot {
  customerName: string
  carrierName: string
  customerRateCents: number
  carrierRateCents: number
  firstStop: { name: string; city: string; zip: string } | null
  lastStop: { name: string; city: string; zip: string } | null
}

export type ActiveCheckField = 'customer' | 'carrier' | 'customerRate' | 'carrierRate' | 'firstStop' | 'lastStop'

export interface ActiveCheckDiff {
  field: ActiveCheckField
  aljex: string
  bcat: string
}

const cityKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const zip5 = (z: string): string => z.replace(/\D/g, '').slice(0, 5)
const money = (cents: number): string => (cents / 100).toFixed(2)

function stopDiff(field: 'firstStop' | 'lastStop', aljex: { name: string; city: string; zip: string }, bcat: BcatShipmentSnapshot['firstStop']): ActiveCheckDiff | null {
  const a = `${aljex.name} | ${aljex.city} | ${zip5(aljex.zip)}`
  if (!bcat) return { field, aljex: a, bcat: '(no stop)' }
  const b = `${bcat.name} | ${bcat.city} | ${zip5(bcat.zip)}`
  // Name and city are lenient (case/punctuation); a blank BCAT zip is "not recorded", not a difference.
  const same = nameKey(aljex.name) === nameKey(bcat.name) && cityKey(aljex.city) === cityKey(bcat.city) && (zip5(bcat.zip) === '' || zip5(aljex.zip) === '' || zip5(aljex.zip) === zip5(bcat.zip))
  return same ? null : { field, aljex: a, bcat: b }
}

/** Differences between an Aljex active-shipment row and BCAT's record of the same PRO (empty = they agree). */
export function compareActiveShipment(row: ActiveShipmentRow, bcat: BcatShipmentSnapshot): ActiveCheckDiff[] {
  const diffs: ActiveCheckDiff[] = []
  if (nameKey(row.customerName) !== nameKey(bcat.customerName)) diffs.push({ field: 'customer', aljex: row.customerName, bcat: bcat.customerName })
  if (nameKey(row.carrierName) !== nameKey(bcat.carrierName)) diffs.push({ field: 'carrier', aljex: row.carrierName, bcat: bcat.carrierName })
  if (row.customerRateCents !== bcat.customerRateCents) diffs.push({ field: 'customerRate', aljex: money(row.customerRateCents), bcat: money(bcat.customerRateCents) })
  if (row.carrierRateCents !== bcat.carrierRateCents) diffs.push({ field: 'carrierRate', aljex: money(row.carrierRateCents), bcat: money(bcat.carrierRateCents) })
  const first = stopDiff('firstStop', { name: row.firstStopName, city: row.firstStopCity, zip: row.firstStopZip }, bcat.firstStop)
  if (first) diffs.push(first)
  const last = stopDiff('lastStop', { name: row.lastStopName, city: row.lastStopCity, zip: row.lastStopZip }, bcat.lastStop)
  if (last) diffs.push(last)
  return diffs
}
