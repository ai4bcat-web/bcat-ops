/**
 * Rate confirmation revisions (Ryne 2026-11-13): a re-sent rate con is "REVISED - REV n" and says
 * what changed since the version before it. Every send stores a compact snapshot of what the PDF
 * printed; the next send diffs against it. Only rate-con content goes in a snapshot (carrier-side
 * money and carrier-visible stop details), so the change list is as safe to print as the PDF.
 *
 * Shared by the browser (which builds the PDF) and tms-shipment-actions (which stores the snapshot
 * and threads the e-mail).
 */
import type { RateConInput, RateConStop } from './carrierRateCon'

export interface RateConSnapshotStop {
  kind: RateConStop['kind']
  name: string | null
  city: string | null
  state: string | null
  apptAt: string | null
  apptEnd: string | null
  apptType: string | null
}

export interface RateConSnapshot {
  charges: { label: string; amountCents: number }[]
  totalCents: number
  stops: RateConSnapshotStop[]
  equipmentType: string | null
  commodity: string | null
  weightLbs: number | null
  pieces: number | null
  miles: number | null
  notes: string
  truckNumber: string | null
  trailerNumber: string | null
  driverName: string | null
  /** What this version changed from the one before it (empty on version 1). */
  changes?: string[]
}

/** Printed on version 2 and up. */
export interface RateConRevision {
  number: number
  at: Date
  changes: string[]
}

const MAX_CHANGES = 20
const MAX_SNAPSHOT_CHARS = 20_000

const blank = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t ? t : null
}

export function rateConSnapshotOf(input: RateConInput): RateConSnapshot {
  return {
    charges: input.charges.map((c) => ({ label: c.label, amountCents: c.amountCents })),
    totalCents: input.totalCents,
    stops: input.stops.map((s) => ({
      kind: s.kind,
      name: blank(s.name),
      city: blank(s.city),
      state: blank(s.state),
      apptAt: blank(s.apptAt),
      apptEnd: blank(s.apptEnd),
      apptType: blank(s.apptType),
    })),
    equipmentType: blank(input.equipmentType),
    commodity: blank(input.commodity),
    weightLbs: input.weightLbs ?? null,
    pieces: input.pieces ?? null,
    miles: input.miles ?? null,
    notes: (input.notes ?? '').trim(),
    truckNumber: blank(input.loadCarrier.truckNumber),
    trailerNumber: blank(input.loadCarrier.trailerNumber),
    driverName: blank(input.loadCarrier.driverName),
  }
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const pad = (n: number) => String(n).padStart(2, '0')

/** MM/DD HH:MM in Chicago, the same clock the rate con prints. */
function clock(iso: string | null): string {
  if (!iso) return 'none'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  )
  return `${parts.month}/${parts.day} ${pad(Number(parts.hour))}:${parts.minute}`
}

function apptText(s: RateConSnapshotStop): string {
  if (!s.apptAt) return 'none'
  if (s.apptType === 'fcfs' && s.apptEnd) return `FCFS ${clock(s.apptAt)} - ${clock(s.apptEnd).slice(6)}`
  if (s.apptEnd && s.apptType === 'range') return `${clock(s.apptAt)} - ${clock(s.apptEnd).slice(6)}`
  return clock(s.apptAt)
}

const place = (s: RateConSnapshotStop) => [s.name, [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(' ')

const chargeKey = (label: string) => label.trim().toUpperCase()

/** Plain-English lines for what moved between two versions. Empty when nothing the carrier sees changed. */
export function rateConChanges(prev: RateConSnapshot, next: RateConSnapshot): string[] {
  const out: string[] = []

  const before = new Map<string, number>()
  for (const c of prev.charges) before.set(chargeKey(c.label), (before.get(chargeKey(c.label)) ?? 0) + c.amountCents)
  const after = new Map<string, number>()
  for (const c of next.charges) after.set(chargeKey(c.label), (after.get(chargeKey(c.label)) ?? 0) + c.amountCents)
  for (const [label, cents] of after) {
    const was = before.get(label)
    if (was == null) out.push(`Added ${label} ${money(cents)}`)
    else if (was !== cents) out.push(`${label} ${money(was)} -> ${money(cents)}`)
  }
  for (const [label, cents] of before) {
    if (!after.has(label)) out.push(`Removed ${label} ${money(cents)}`)
  }
  if (prev.totalCents !== next.totalCents) out.push(`Total rate ${money(prev.totalCents)} -> ${money(next.totalCents)}`)

  let picks = 0
  let drops = 0
  const name = (s: RateConSnapshotStop) => (s.kind === 'PICKUP' ? `Pick ${++picks}` : `Stop ${++drops}`)
  const longest = Math.max(prev.stops.length, next.stops.length)
  for (let i = 0; i < longest; i++) {
    const p = prev.stops[i]
    const n = next.stops[i]
    if (n && !p) { out.push(`Added ${name(n)}: ${place(n)}`.trim()); continue }
    if (p && !n) { out.push(`Removed stop: ${place(p)}`.trim()); continue }
    if (!p || !n) continue
    const label = name(n)
    if (place(p) !== place(n)) out.push(`${label} location ${place(p) || 'none'} -> ${place(n) || 'none'}`)
    if (apptText(p) !== apptText(n)) out.push(`${label} appointment ${apptText(p)} -> ${apptText(n)}`)
  }

  const field = (label: string, a: string | number | null, b: string | number | null) => {
    if ((a ?? '') !== (b ?? '')) out.push(`${label} ${a ?? 'none'} -> ${b ?? 'none'}`)
  }
  field('Equipment', prev.equipmentType, next.equipmentType)
  field('Description', prev.commodity, next.commodity)
  field('Weight', prev.weightLbs, next.weightLbs)
  field('Pieces', prev.pieces, next.pieces)
  field('Miles', prev.miles, next.miles)
  field('Truck #', prev.truckNumber, next.truckNumber)
  field('Trailer #', prev.trailerNumber, next.trailerNumber)
  field('Driver', prev.driverName, next.driverName)
  if (prev.notes !== next.notes) out.push('Dispatch notes updated')

  return out.length > MAX_CHANGES ? [...out.slice(0, MAX_CHANGES - 1), `...and ${out.length - MAX_CHANGES + 1} more`] : out
}

/**
 * The revision block for the version about to be sent: null for a first send. `previous` is the
 * snapshot stored with the version before it (null when that send predates snapshots).
 */
export function rateConRevisionFor(
  nextVersion: number, previous: RateConSnapshot | null, next: RateConSnapshot, at: Date = new Date(),
): RateConRevision | null {
  if (nextVersion < 2) return null
  return { number: nextVersion, at, changes: previous ? rateConChanges(previous, next) : [] }
}

/** Server-side guard for a snapshot the browser sent: a plain object, bounded, change lines trimmed. Null when unusable. */
export function parseRateConSnapshot(raw: unknown): RateConSnapshot | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_SNAPSHOT_CHARS) return null
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Partial<RateConSnapshot>
  if (!Array.isArray(v.charges) || !Array.isArray(v.stops) || typeof v.totalCents !== 'number') return null
  if (JSON.stringify(v).length > MAX_SNAPSHOT_CHARS) return null
  const changes = Array.isArray(v.changes)
    ? v.changes.filter((c): c is string => typeof c === 'string').slice(0, MAX_CHANGES).map((c) => c.replace(/[\r\n]+/g, ' ').slice(0, 200))
    : []
  return { ...(v as RateConSnapshot), changes }
}

/** The subject a revision rides: the first send's, as a reply, so mail clients keep one thread. */
export function revisedRateConSubject(original: string): string {
  return /^re:/i.test(original.trim()) ? original.trim() : `RE: ${original.trim()}`
}

/** In-Reply-To / References for the next rate con on this assignment, from the earlier sends (oldest first). */
export function rateConThreadHeaders(
  messages: readonly { kind?: unknown; direction?: unknown; loadCarrierId?: unknown; status?: unknown; messageId?: unknown; subject?: unknown; at?: unknown }[],
  loadCarrierId: string,
): { inReplyTo: string; references: string; originalSubject: string } | null {
  const earlier = messages
    .filter((m) => m.kind === 'RATE_CON' && m.direction === 'OUT' && m.loadCarrierId === loadCarrierId
      && m.status === 'SENT' && typeof m.messageId === 'string' && m.messageId.trim())
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  if (earlier.length === 0) return null
  const ids = earlier.map((m) => String(m.messageId).trim())
  // The first message plus the most recent ones keeps the header short and the thread intact.
  const refs = ids.length > 10 ? [ids[0], ...ids.slice(-9)] : ids
  return {
    inReplyTo: ids[ids.length - 1],
    references: refs.join(' '),
    originalSubject: String(earlier[0].subject ?? '').replace(/^(re:\s*)+/i, '').trim(),
  }
}
