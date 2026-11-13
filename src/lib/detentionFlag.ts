/**
 * Detention flag (Ryne 2026-11-13): a live shipment where the truck is being held at a stop and the
 * load will need detention. Raised from the Active Shipments board (or the shipment page), shown as a
 * "Detention" pill there, on the shipment, and in Load Review so billing remembers to add the detention
 * accessorial to the customer invoice and to check the carrier's detention charge. Nothing is charged
 * automatically.
 *
 * Stored as one JSON object on the Shipment (`Shipment.detentionFlag`), written only by the
 * tms-shipment-actions SET_DETENTION_FLAG action, which stamps who and when. null = not flagged.
 *
 * Pure: shared by the Lambda and the UI.
 */

export type DetentionStopType = 'pickup' | 'delivery'

export interface DetentionFlag {
  stopType: DetentionStopType
  /** The stop on the shipment, when the person picked one ("Pickup 1 · MRS - WORLEY WAREHOUSE"). */
  stopId?: string | null
  stopLabel?: string | null
  /** ISO instants, when known. */
  arrivedAt?: string | null
  departedAt?: string | null
  /** Hours waited, when known (typed, or worked out from arrived/departed). */
  hours?: number | null
  note?: string | null
  flaggedAt: string
  flaggedBy: string
}

/** What a caller may send; the action stamps flaggedAt / flaggedBy. */
export type DetentionFlagInput = Omit<DetentionFlag, 'flaggedAt' | 'flaggedBy'>

export const DETENTION_NOTE_MAX = 500
export const DETENTION_LABEL_MAX = 160
export const DETENTION_MAX_HOURS = 240

const isIso = (v: string): boolean => Number.isFinite(Date.parse(v))

const optText = (v: unknown, max: number): string | null => {
  if (v == null) return null
  if (typeof v !== 'string') throw new Error('Detention: text fields must be text')
  const t = v.trim()
  if (!t) return null
  if (t.length > max) throw new Error(`Detention: text is too long (${max} characters at most)`)
  return t
}

const optInstant = (v: unknown, label: string): string | null => {
  const t = optText(v, 40)
  if (t == null) return null
  if (!isIso(t)) throw new Error(`Detention: ${label} is not a valid date and time`)
  return new Date(t).toISOString()
}

/** Whole hours between two instants, rounded to a quarter hour; null when either is missing or out of order. */
export function hoursBetween(arrivedAt: string | null | undefined, departedAt: string | null | undefined): number | null {
  if (!arrivedAt || !departedAt) return null
  const ms = Date.parse(departedAt) - Date.parse(arrivedAt)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round((ms / 3_600_000) * 4) / 4
}

/** Validates a client's flag. Throws a sentence a person can act on. */
export function validateDetentionInput(raw: unknown): DetentionFlagInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Detention: send the flag details')
  const r = raw as Record<string, unknown>
  if (r.stopType !== 'pickup' && r.stopType !== 'delivery') throw new Error('Detention: choose the pickup or the delivery stop')
  const arrivedAt = optInstant(r.arrivedAt, 'arrived')
  const departedAt = optInstant(r.departedAt, 'departed')
  if (arrivedAt && departedAt && Date.parse(departedAt) <= Date.parse(arrivedAt)) {
    throw new Error('Detention: departed must be after arrived')
  }
  let hours: number | null = null
  if (r.hours != null && r.hours !== '') {
    const n = typeof r.hours === 'number' ? r.hours : Number(r.hours)
    if (!Number.isFinite(n) || n <= 0 || n > DETENTION_MAX_HOURS) throw new Error(`Detention: hours waited must be between 0 and ${DETENTION_MAX_HOURS}`)
    hours = Math.round(n * 4) / 4
  }
  if (hours == null) hours = hoursBetween(arrivedAt, departedAt)
  return {
    stopType: r.stopType,
    stopId: optText(r.stopId, 100),
    stopLabel: optText(r.stopLabel, DETENTION_LABEL_MAX),
    arrivedAt,
    departedAt,
    hours,
    note: optText(r.note, DETENTION_NOTE_MAX),
  }
}

/** The stored flag, or null. Tolerates the JSON string AppSync sometimes hands back. */
export function parseDetentionFlag(raw: unknown): DetentionFlag | null {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if ((r.stopType !== 'pickup' && r.stopType !== 'delivery') || typeof r.flaggedAt !== 'string') return null
  return r as unknown as DetentionFlag
}

const fmtHours = (h: number): string => `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} ${h === 1 ? 'hr' : 'hrs'}`

/** "Delivery · IFF - GENECOR · 3.5 hrs" */
export function detentionSummary(flag: DetentionFlag): string {
  const parts = [flag.stopLabel?.trim() || (flag.stopType === 'pickup' ? 'Pickup' : 'Delivery')]
  if (flag.hours != null && flag.hours > 0) parts.push(fmtHours(flag.hours))
  return parts.join(' · ')
}

/** Multi-line hover text: stop, hours, times, note, who and when. `formatTime` renders an ISO instant. */
export function detentionTooltip(flag: DetentionFlag, formatTime: (iso: string) => string): string {
  const lines = [`Detention at ${detentionSummary(flag)}`]
  if (flag.arrivedAt) lines.push(`Arrived ${formatTime(flag.arrivedAt)}`)
  if (flag.departedAt) lines.push(`Departed ${formatTime(flag.departedAt)}`)
  if (flag.note) lines.push(flag.note)
  lines.push(`Flagged by ${flag.flaggedBy} · ${formatTime(flag.flaggedAt)}`)
  return lines.join('\n')
}
