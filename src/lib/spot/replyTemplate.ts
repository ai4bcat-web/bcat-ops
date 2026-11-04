/**
 * Step AB §4.6 / D15 — the reply, rendered from VALIDATED fields only (enums, numbers,
 * dates, the minted link). Model free text (notes, commodity, customer name) is not an
 * input, so an instruction injected into a customer mail cannot reach the outgoing text.
 * The only user text is the rep's intro/outro/signature, CR/LF-normalised and capped.
 * Used by the page preview and the Lambda so the two cannot diverge. Pure.
 */
import { stripControl } from './text'

export interface SpotReplyInput {
  rateCents: number
  origin: { city: string; state: string }
  destination: { city: string; state: string }
  equipmentType: string
  lengthFt: number | null
  pickupDate: string | null
  expiresAt: string | null
  /** The public accept link; empty when no quote exists yet (the line is then left out). */
  link: string
  intro?: string | null
  outro?: string | null
  signature?: string | null
}

const EQUIPMENT_LABEL: Record<string, string> = {
  VAN: 'dry van',
  REEFER: 'reefer',
  FLATBED: 'flatbed',
  STEPDECK: 'step deck',
  POWER_ONLY: 'power only',
  CONESTOGA: 'conestoga',
  BOX_TRUCK: 'box truck',
  SPRINTER: 'sprinter van',
  OTHER: 'truck',
}

const USER_TEXT_MAX = 600

/** One line, no control characters (header-injection safe). */
function oneLine(value: string, max = 80): string {
  return stripControl(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Multi-line user text: CR removed, control characters dropped, capped. */
function userText(value: string | null | undefined): string {
  if (!value) return ''
  return stripControl(value.replace(/\r\n?/g, '\n'), '', true).slice(0, USER_TEXT_MAX).trim()
}

function money(cents: number): string {
  const dollars = Math.round(cents) / 100
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 })}`
}

function longDate(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null
  const at = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function renderSpotReply(i: SpotReplyInput): string {
  const equipment = `${i.lengthFt ? `${i.lengthFt}' ` : ''}${EQUIPMENT_LABEL[i.equipmentType] ?? 'truck'}`
  const lines: string[] = []
  const intro = userText(i.intro)
  if (intro) lines.push(intro, '')
  lines.push(
    `Rate: ${money(i.rateCents)} all-in`,
    `Lane: ${oneLine(i.origin.city, 60)}, ${oneLine(i.origin.state, 2)} to ${oneLine(i.destination.city, 60)}, ${oneLine(i.destination.state, 2)}`,
    `Equipment: ${equipment}`,
  )
  const pickup = longDate(i.pickupDate)
  if (pickup) lines.push(`Pickup: ${pickup}`)
  const valid = longDate(i.expiresAt)
  if (valid) lines.push(`Valid through: ${valid}`)
  const link = oneLine(i.link, 500).replace(/\s/g, '')
  if (link) lines.push('', `To accept this quote, use this link: ${link}`)
  const outro = userText(i.outro)
  if (outro) lines.push('', outro)
  const signature = userText(i.signature)
  if (signature) lines.push('', '--', signature)
  return lines.join('\n')
}

/** `Re: <subject>`, never doubled, one line. */
export function replySubject(original: string | null | undefined): string {
  const base = oneLine(original ?? '', 200).replace(/^((re|fwd?)\s*:\s*)+/i, '')
  return `Re: ${base || 'Your quote request'}`
}
