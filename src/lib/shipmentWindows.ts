// Pure windowing helpers for the board loaders. No I/O.
import type { ShipmentRecord, ShipmentStatus } from '@/types/tms'
import { SHIPMENT_STATUSES } from '@/lib/shipmentStatus'

const TERMINAL: readonly ShipmentStatus[] = ['DELIVERED', 'CANCELED']

/** Every status a person can still act on: the enum minus DELIVERED and CANCELED. */
export const OPEN_SHIPMENT_STATUSES: readonly ShipmentStatus[] =
  SHIPMENT_STATUSES.filter((s) => !TERMINAL.includes(s))

export const TERMINAL_SHIPMENT_STATUSES: readonly ShipmentStatus[] = TERMINAL

const DATE_RE = /^(\d{4})-(\d{2})(?:-\d{2})?/

function parseMonth(s: string): number | null {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return Number(m[1]) * 12 + (mo - 1)
}

function formatMonth(index: number): string {
  const y = Math.floor(index / 12)
  return `${String(y).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

/**
 * Months ('YYYY-MM', sorted, unique) covering the inclusive range from..to, widened by
 * padMonths each side. The pad covers the UTC-vs-local month edge: `pickupMonth` is the
 * first 7 chars of the stored ISO `pickupAppt`. `from > to` is treated as the swapped
 * range. Unparseable input yields [].
 */
export function monthsCovering(from: string, to: string, padMonths = 1): string[] {
  const a = parseMonth(from)
  const b = parseMonth(to)
  if (a === null || b === null) return []
  const pad = Math.max(0, Math.floor(padMonths))
  const lo = Math.min(a, b) - pad
  const hi = Math.max(a, b) + pad
  const out: string[] = []
  for (let i = lo; i <= hi; i++) out.push(formatMonth(i))
  return out
}

/** 'YYYY-MM' of `now` in UTC (the key `pickupMonth` is built from). */
export function currentMonth(now: Date): string {
  return `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Dedupe by id across sets; the row with the later `updatedAt` wins, later set wins ties. */
export function mergeShipmentSets(...sets: ShipmentRecord[][]): ShipmentRecord[] {
  const byId = new Map<string, ShipmentRecord>()
  for (const set of sets) {
    for (const row of set) {
      const prev = byId.get(row.id)
      if (!prev || (row.updatedAt ?? '') >= (prev.updatedAt ?? '')) byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}
