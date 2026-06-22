/**
 * Trip CSV / paste parsing for Amazon driver pay.
 *
 * Handles the raw Amazon Relay "Trips" export (Driver Name, Estimated Cost, Estimate
 * Distance, Facility Sequence "A->B", Equipment Type, Load Execution Status, plus many
 * extra columns and a UTF-8 BOM) as well as a simple positional paste. The header row is
 * auto-detected and mapped by column NAME; rows without a numeric cost/freight are
 * skipped. Rate/mile is derived from cost ÷ distance when the export doesn't carry it.
 */

export interface RawTripRow {
  loadId: string | null
  origin: string | null
  destination: string | null
  miles: number | null
  equipment: string | null
  freightAmount: number
  ratePerMile: number | null
  dispatcher: string | null
  status: string | null
  driverName: string   // Driver/Dispatcher column — used to route a master CSV per driver
}

/** Parse a money/number string ("$5,248.52" → 5248.52); null if not numeric. */
function num(s: string): number | null {
  const n = parseFloat(s.replace(/[$,\s]/g, ''))
  return isFinite(n) ? n : null
}

/** Quote-aware split of one CSV line (handles "fields, with commas" and "" escapes). */
export function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur); return out
}

export function parseRows(text: string): RawTripRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const useTab = lines[0].includes('\t')
  const split = useTab ? (l: string) => l.split('\t') : splitCsv

  let header: string[] | null = null
  if (/load\s*id|driver|freight|cost|origin|dispatch|equipment|facility|distance/i.test(lines[0]) && !/^\$?-?\d/.test(lines[0].trim())) {
    header = split(lines.shift()!).map((h) => h.trim().toLowerCase())
  }
  const idx = (...names: string[]) => header ? header.findIndex((h) => names.some((n) => h.includes(n))) : -1
  const cols = header
    ? {
        loadId: idx('load id', 'load'), origin: idx('origin'), dest: idx('destination'),
        sequence: idx('facility sequence', 'sequence', 'domicile/route'),
        miles: idx('estimate distance', 'distance', 'mile'), equip: idx('equipment'),
        freight: idx('estimated cost', 'cost', 'freight', 'amount'), rpm: idx('rate per mile', 'rate/mi'),
        disp: idx('dispatch'), driver: idx('driver'), status: idx('execution status', 'trip stage', 'status'),
      }
    : { loadId: 0, origin: 1, dest: 2, sequence: -1, miles: 3, equip: 4, freight: 5, rpm: 6, disp: 7, driver: -1, status: 8 }

  const at = (c: string[], i: number) => (i >= 0 && i < c.length ? c[i].trim() : '')
  const out: RawTripRow[] = []
  for (const line of lines) {
    const c = split(line)
    const freight = num(at(c, cols.freight))
    if (freight == null) continue

    let origin = at(c, cols.origin) || null
    let destination = at(c, cols.dest) || null
    if ((!origin || !destination) && cols.sequence >= 0) {
      const parts = at(c, cols.sequence).split(/->|→/).map((s) => s.trim()).filter(Boolean)
      if (parts.length) { origin = origin || parts[0]; destination = destination || (parts.length > 1 ? parts[parts.length - 1] : null) }
    }

    const miles = num(at(c, cols.miles))
    let ratePerMile = num(at(c, cols.rpm))
    if (ratePerMile == null && miles && miles > 0) ratePerMile = Math.round((freight / miles) * 100) / 100

    const dispatcher = at(c, cols.disp) || null
    out.push({
      loadId: at(c, cols.loadId) || null, origin, destination,
      miles, equipment: at(c, cols.equip) || null, freightAmount: freight,
      ratePerMile, dispatcher, status: at(c, cols.status) || null,
      driverName: (at(c, cols.driver) || dispatcher || '').trim(),
    })
  }
  return out
}
