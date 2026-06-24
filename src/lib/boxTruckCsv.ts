/**
 * Box-truck shipment CSV / paste parsing for Zak's (Ivan Cartage) biweekly pay.
 *
 * Handles the Ivan Cartage "Trips" spreadsheet export. Columns are mapped by NAME
 * (header auto-detected; any banner/summary rows above the header are skipped).
 * The pay basis is `shipment_gross_profit`; rows without a numeric gross profit are
 * skipped. `shipment_equipment` (e.g. "ZAK") routes a multi-driver file per driver.
 */
import { splitCsv } from './tripCsv'

export interface RawBoxTruckRow {
  proNumber:    string | null
  customer:     string | null
  salesRep:     string | null
  loadDesc:     string | null
  customerRate: number | null
  carrierCost:  number | null
  grossProfit:  number
  status:       string | null
  driverName:   string   // shipment_equipment — routes a master file per driver
}

/** Parse a money/number string ("$1,150.00" → 1150); null if not numeric. */
function num(s: string): number | null {
  const n = parseFloat(s.replace(/[$,\s]/g, ''))
  return isFinite(n) ? n : null
}

const HEADER_RE = /shipment_pro|gross[_ ]?profit|customer name|shipment_equipment/i

export function parseBoxTruckRows(text: string): RawBoxTruckRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []

  // Find the header row, skipping any banner/summary rows above it (e.g. "Trips:" / "Percentage: 50%").
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l))
  if (headerIdx < 0) return []

  const headerLine = lines[headerIdx]
  const useTab = headerLine.includes('\t')
  const split = useTab ? (l: string) => l.split('\t') : splitCsv
  const header = split(headerLine).map((h) => h.trim().toLowerCase())
  const idx = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)))

  const cols = {
    pro:          idx('shipment_pro', 'pro number', 'pro#'),
    driver:       idx('shipment_equipment', 'equipment'),
    customer:     idx('customer name', 'customer_name'),
    salesRep:     idx('sales rep', 'sales_rep'),
    loadDesc:     idx('shipment_load_des', 'load_des', 'load des'),
    customerRate: idx('customer_total_rates', 'customer total rates'),
    carrierCost:  idx('carrier_total_rates', 'carrier total rates'),
    grossProfit:  idx('gross_profit', 'gross profit'),
    status:       idx('shipment_status', 'status'),
  }

  const at = (c: string[], i: number) => (i >= 0 && i < c.length ? c[i].trim() : '')
  const out: RawBoxTruckRow[] = []
  for (const line of lines.slice(headerIdx + 1)) {
    const c = split(line)
    const gp = num(at(c, cols.grossProfit))
    if (gp == null) continue
    out.push({
      proNumber:    at(c, cols.pro) || null,
      customer:     at(c, cols.customer) || null,
      salesRep:     at(c, cols.salesRep) || null,
      loadDesc:     at(c, cols.loadDesc) || null,
      customerRate: num(at(c, cols.customerRate)),
      carrierCost:  num(at(c, cols.carrierCost)),
      grossProfit:  gp,
      status:       at(c, cols.status) || null,
      driverName:   at(c, cols.driver) || '',
    })
  }
  return out
}
