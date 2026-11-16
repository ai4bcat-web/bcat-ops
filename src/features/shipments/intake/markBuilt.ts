/**
 * "Already built" (Ryne 2026-11-16): anyone on Build can tie an intake e-mail to the PRO they built it as outside the Build page.
 * The pure parts: pick the live shipment for a typed PRO, and the soft warnings when it does not look like the e-mail.
 */
import type { IntakeLoadRecord } from '@/types/intake'
import type { ShipmentRecord } from '@/types/tms'

export type ProLookup =
  | { kind: 'empty' }
  | { kind: 'notFound' }
  | { kind: 'voided' }
  | { kind: 'found'; shipment: ShipmentRecord }

const live = (v: unknown): boolean => typeof v === 'string' && v.length > 0

/** The typed PRO's shipment: a voided/deleted PRO is refused, a live one wins over a voided duplicate number. */
export function pickShipmentForPro(pro: string, rows: readonly ShipmentRecord[]): ProLookup {
  if (!pro.trim()) return { kind: 'empty' }
  const same = rows.filter((s) => String(s.number).trim().toLowerCase() === pro.trim().toLowerCase())
  if (same.length === 0) return { kind: 'notFound' }
  const alive = same.find((s) => !live(s.voidedAt) && !live(s.deletedAt))
  return alive ? { kind: 'found', shipment: alive } : { kind: 'voided' }
}

const norm = (v: string | null | undefined): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const cityOf = (v: string | null | undefined): string => norm(String(v ?? '').split(',')[0])

/** Soft warnings: the PRO is allowed, but the user sees why it might be the wrong one. */
export function markBuiltWarnings(row: IntakeLoadRecord, shipment: ShipmentRecord): string[] {
  const out: string[] = []
  const f = row.fields
  const customerMismatch = f.customerId && shipment.customerId
    ? f.customerId !== shipment.customerId
    : Boolean(f.customerName && shipment.customerName) && !norm(shipment.customerName).includes(norm(f.customerName).split(' ')[0] ?? '')
  if (customerMismatch) out.push(`The e-mail's customer is ${f.customerName ?? 'different'}; PRO ${shipment.number} is ${shipment.customerName ?? 'another customer'}.`)
  const pick = f.stops.find((s) => s.type === 'pickup')
  const drop = [...f.stops].reverse().find((s) => s.type === 'delivery')
  const laneMismatch = (pick?.city && shipment.originCity && cityOf(pick.city) !== cityOf(shipment.originCity))
    || (drop?.city && shipment.destinationCity && cityOf(drop.city) !== cityOf(shipment.destinationCity))
  if (laneMismatch) out.push(`The e-mail's lane is ${pick?.city ?? '—'} → ${drop?.city ?? '—'}; PRO ${shipment.number} runs ${shipment.originCity ?? '—'} → ${shipment.destinationCity ?? '—'}.`)
  return out
}

/** The server's "already linked to another e-mail" refusal, which the dialog turns into a confirm. */
export function isAlreadyLinkedError(message: string): boolean {
  return message.startsWith('ALREADY_LINKED:')
}

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** Linked rows touched in the last 14 days, newest first. */
export function recentlyBuilt(rows: readonly IntakeLoadRecord[], now = Date.now()): IntakeLoadRecord[] {
  return rows
    .filter((r) => r.shipmentId && now - Date.parse(r.updatedAt) <= WINDOW_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
