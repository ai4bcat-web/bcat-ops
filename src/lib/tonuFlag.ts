/**
 * TONU flag (Ryne 2026-11-16): a shipment where the truck was ordered but not used (cancelled after dispatch, load not ready,
 * shipper turned the truck away), so the load is waiting on a TONU (truck order not used) charge. Raised from the Calendar or the
 * Active Shipments board (or the shipment page), shown as a "TONU" pill next to the detention pill, on the shipment and in Load
 * Review so billing remembers to add the TONU accessorial to the customer invoice and to check the carrier's TONU charge.
 * Nothing is charged automatically.
 *
 * Stored as one JSON object on the Shipment (`Shipment.tonuFlag`), written only by the tms-shipment-actions SET_TONU_FLAG
 * action, which stamps who and when. null = not flagged. Same shape of idea as `detentionFlag`.
 *
 * Pure: shared by the Lambda and the UI.
 */

export interface TonuFlag {
  /** Why the truck was not used ("Shipper cancelled at the dock"). */
  note?: string | null
  /** What the TONU is expected to be, in dollars, when the person knows it. */
  amount?: number | null
  flaggedAt: string
  flaggedBy: string
}

/** What a caller may send; the action stamps flaggedAt / flaggedBy. */
export type TonuFlagInput = Omit<TonuFlag, 'flaggedAt' | 'flaggedBy'>

export const TONU_NOTE_MAX = 500
export const TONU_MAX_AMOUNT = 100_000

/** Validates a client's flag. Throws a sentence a person can act on. */
export function validateTonuInput(raw: unknown): TonuFlagInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('TONU: send the flag details')
  const r = raw as Record<string, unknown>
  let note: string | null = null
  if (r.note != null) {
    if (typeof r.note !== 'string') throw new Error('TONU: the note must be text')
    const t = r.note.trim()
    if (t.length > TONU_NOTE_MAX) throw new Error(`TONU: the note is too long (${TONU_NOTE_MAX} characters at most)`)
    note = t || null
  }
  let amount: number | null = null
  if (r.amount != null && r.amount !== '') {
    const n = typeof r.amount === 'number' ? r.amount : Number(r.amount)
    if (!Number.isFinite(n) || n <= 0 || n > TONU_MAX_AMOUNT) throw new Error(`TONU: the amount must be between $0 and $${TONU_MAX_AMOUNT.toLocaleString('en-US')}`)
    amount = Math.round(n * 100) / 100
  }
  return { note, amount }
}

/** The stored flag, or null. Tolerates the JSON string AppSync sometimes hands back. */
export function parseTonuFlag(raw: unknown): TonuFlag | null {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (typeof r.flaggedAt !== 'string') return null
  return r as unknown as TonuFlag
}

const money = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`

/** "TONU · $250" or "TONU" */
export function tonuSummary(flag: TonuFlag): string {
  return flag.amount != null && flag.amount > 0 ? `TONU · ${money(flag.amount)}` : 'TONU'
}

/** Multi-line hover text: amount, note, who and when. `formatTime` renders an ISO instant. */
export function tonuTooltip(flag: TonuFlag, formatTime: (iso: string) => string): string {
  const lines = [`Waiting for TONU${flag.amount != null && flag.amount > 0 ? ` (${money(flag.amount)})` : ''}`]
  if (flag.note) lines.push(flag.note)
  lines.push(`Flagged by ${flag.flaggedBy} · ${formatTime(flag.flaggedAt)}`)
  return lines.join('\n')
}
