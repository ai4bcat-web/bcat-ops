/**
 * Ryne 2026-11-19: when a driver sends a photo or document and says in its note that it is detention ("Detention pay"),
 * the shipment is flagged for detention automatically, so the Active Shipments strip, the list badge, the calendar and
 * Load Review all show it without anyone setting the flag by hand. The same goes for a TONU note.
 *
 * The driver app has no "Detention" document type: a stop photo or an 'Other' additional document carries a free-text note
 * ("Detention pay", "detention sheet"). So this reads the note. It flags only; nothing is charged (billing adds the
 * accessorial from Load Review).
 *
 * Pure: shared by the driver-app Lambda and its tests.
 */

export type DriverDocAccessorial = 'DETENTION' | 'TONU'

const DETENTION_WORDS = /\bdetention\b|\bdetn\b|\bdtl\b|\bdetain(?:ed)?\b/i
const TONU_WORDS = /\btonu\b|\btruck\s*order(?:ed)?\s*not\s*used\b/i
/** "no detention", "not detention", "without detention", "no tonu": a note that rules it out is not a request for it. */
const NEGATED = /\b(?:no|not|without|never|zero|n\/a)\b[\s:,-]{0,4}(?:any\s+)?(?:detention|detn|tonu)\b/i

/**
 * Which accessorial flags a driver's note asks for. Empty for a blank note, an unrelated note, or one that rules it out.
 * Both can be returned when the note names both.
 */
export function driverDocAccessorials(note: string | null | undefined): DriverDocAccessorial[] {
  const text = (note ?? '').trim()
  if (!text) return []
  const out: DriverDocAccessorial[] = []
  if (DETENTION_WORDS.test(text) && !negates(text, DETENTION_WORDS)) out.push('DETENTION')
  if (TONU_WORDS.test(text) && !negates(text, TONU_WORDS)) out.push('TONU')
  return out
}

/** True when every mention of the word in the note is negated ("no detention"). */
function negates(text: string, word: RegExp): boolean {
  const source = word.source
  const global = new RegExp(source, 'gi')
  let found = 0
  let negated = 0
  for (const match of text.matchAll(global)) {
    found += 1
    const start = Math.max(0, (match.index ?? 0) - 16)
    const window = text.slice(start, (match.index ?? 0) + match[0].length)
    if (NEGATED.test(window)) negated += 1
  }
  return found > 0 && negated === found
}

/** Which stop type a driver photo was taken at: the stop on the load, else the label ("Pickup — INGREDION INC"), else the delivery. */
export function stopTypeForDriverDoc(
  stop: { type?: string | null } | null | undefined,
  stopLabel: string | null | undefined,
): 'pickup' | 'delivery' {
  const type = String(stop?.type ?? '').toLowerCase()
  if (type === 'pickup' || type === 'delivery') return type
  const label = (stopLabel ?? '').trim().toLowerCase()
  if (label.startsWith('pickup')) return 'pickup'
  return 'delivery'
}

/** The line the flag carries: what the driver wrote, and that it came from the driver app. */
export function driverDocFlagNote(input: { driverName: string; note: string | null | undefined }): string {
  const said = (input.note ?? '').trim()
  return `Driver note: "${said}" — ${input.driverName}, driver app`.slice(0, 480)
}
