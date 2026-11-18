/**
 * To-void flag (Ryne 2026-11-18): a review marker staff put on a shipment that should be voided but has not been yet
 * ("duplicate of 14872", "customer cancelled, waiting on the dock"). It sits beside the detention and TONU flags: raised from the
 * Active Shipments board or the shipment page, shown as a "To void" pill, counted in the stats strip, and cleared by hand.
 * Anyone on the team may void (PR #630), so this is not a permission gate: it is a note that a shipment needs a second look.
 * Nothing about the shipment changes while it is flagged; it stays on the calendar, in AR and in AP until it is actually voided,
 * and voiding it clears the flag.
 *
 * Stored as one JSON object on the Shipment (`Shipment.toVoidFlag`), written only by the tms-shipment-actions
 * SET_TO_VOID_FLAG action (and cleared by VOID_SHIPMENT), which stamps who and when. null = not flagged.
 *
 * Pure: shared by the Lambda and the UI.
 */

export interface ToVoidFlag {
  /** Why it should be voided. Required. */
  reason: string
  /** Anything else the person voiding it should know. */
  note?: string | null
  flaggedAt: string
  flaggedBy: string
}

/** What a caller may send; the action stamps flaggedAt / flaggedBy. */
export type ToVoidFlagInput = Omit<ToVoidFlag, 'flaggedAt' | 'flaggedBy'>

export const TO_VOID_REASON_MAX = 300
export const TO_VOID_NOTE_MAX = 500

/** Validates a client's flag. Throws a sentence a person can act on. */
export function validateToVoidInput(raw: unknown): ToVoidFlagInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('To void: send the flag details')
  const r = raw as Record<string, unknown>
  if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error('To void: say why this shipment should be voided')
  const reason = r.reason.trim()
  if (reason.length > TO_VOID_REASON_MAX) throw new Error(`To void: the reason is too long (${TO_VOID_REASON_MAX} characters at most)`)
  let note: string | null = null
  if (r.note != null) {
    if (typeof r.note !== 'string') throw new Error('To void: the note must be text')
    const t = r.note.trim()
    if (t.length > TO_VOID_NOTE_MAX) throw new Error(`To void: the note is too long (${TO_VOID_NOTE_MAX} characters at most)`)
    note = t || null
  }
  return { reason, note }
}

/** The stored flag, or null. Tolerates the JSON string AppSync sometimes hands back. */
export function parseToVoidFlag(raw: unknown): ToVoidFlag | null {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (typeof r.flaggedAt !== 'string' || typeof r.reason !== 'string') return null
  return r as unknown as ToVoidFlag
}

/** "To void · duplicate of 14872" */
export function toVoidSummary(flag: ToVoidFlag): string {
  return `To void · ${flag.reason}`
}

/** Multi-line hover text: reason, note, who and when. `formatTime` renders an ISO instant. */
export function toVoidTooltip(flag: ToVoidFlag, formatTime: (iso: string) => string): string {
  const lines = [`Flagged to void: ${flag.reason}`]
  if (flag.note) lines.push(flag.note)
  lines.push(`Flagged by ${flag.flaggedBy} · ${formatTime(flag.flaggedAt)}`)
  return lines.join('\n')
}
