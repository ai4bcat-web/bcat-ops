/**
 * tms-spot-quoter — the outgoing reply, built from the Quote row and validated fields
 * (never from model free text; `renderSpotReply` takes only enums, numbers, dates and
 * the minted link). Shared by SPOT_CREATE_DRAFT and the auto-send path.
 */
import type { GmailRepSettings, SpotExtraction, SpotRequestRecord } from '../../../src/types/tms'
import type { GmailPort, OutgoingReply } from '../../../src/lib/spot/port'
import { renderSpotReply, replySubject } from '../../../src/lib/spot/replyTemplate'
import type { SpotDeps } from './deps'
import type { Row } from './store'

export function recipientOf(row: Pick<SpotRequestRecord, 'contactEmail' | 'replyTo' | 'fromEmail'>): string {
  return (row.contactEmail ?? row.replyTo ?? row.fromEmail ?? '').trim()
}

function endpoints(extraction: SpotExtraction | null | undefined): {
  origin: { city: string; state: string }
  destination: { city: string; state: string }
} {
  const stops = extraction?.stops ?? []
  const pickup = stops.find((s) => s.type === 'PICKUP') ?? stops[0]
  const delivery = [...stops].reverse().find((s) => s.type === 'DELIVERY') ?? stops[stops.length - 1]
  return {
    origin: { city: pickup?.city ?? '', state: pickup?.state ?? '' },
    destination: { city: delivery?.city ?? '', state: delivery?.state ?? '' },
  }
}

export function quoteLink(deps: Pick<SpotDeps, 'portalOrigin'>, quote: Row): string {
  const token = typeof quote.linkToken === 'string' ? quote.linkToken : ''
  if (!token || !deps.portalOrigin) return ''
  return `${deps.portalOrigin.replace(/\/+$/, '')}/quote/${token}`
}

/** Threading headers come from the customer's own message; a pasted request has none. */
async function threadingOf(port: GmailPort, row: SpotRequestRecord): Promise<{ inReplyTo: string | null; references: string | null }> {
  if (!row.gmailThreadId) return { inReplyTo: null, references: null }
  try {
    const meta = await port.getMetadata(row.gmailMessageId)
    const references = [meta.references, meta.messageId].filter(Boolean).join(' ').trim()
    return { inReplyTo: meta.messageId || null, references: references || null }
  } catch {
    return { inReplyTo: null, references: null }
  }
}

export async function buildReply(
  deps: Pick<SpotDeps, 'portalOrigin'>,
  port: GmailPort,
  row: SpotRequestRecord,
  quote: Row,
  repSettings: Pick<GmailRepSettings, 'signature'>,
  text: { intro?: string | null; outro?: string | null } = {},
): Promise<OutgoingReply> {
  const to = recipientOf(row)
  if (!to) throw new Error('This request has no reply address.')
  const link = quoteLink(deps, quote)
  if (!link) throw new Error('This quote has no customer link yet — send it from the quote first.')
  const extraction = row.extraction ?? null
  const { origin, destination } = endpoints(extraction)
  const body = renderSpotReply({
    rateCents: Number(quote.amountCents ?? 0),
    origin,
    destination,
    equipmentType: String(quote.equipmentType ?? extraction?.equipmentType ?? 'VAN'),
    lengthFt: typeof quote.equipmentLengthFt === 'number' ? quote.equipmentLengthFt : extraction?.lengthFt ?? null,
    pickupDate: extraction?.pickupDate ?? null,
    expiresAt: typeof quote.expiresAt === 'string' ? quote.expiresAt : null,
    link,
    intro: text.intro,
    outro: text.outro,
    signature: repSettings.signature,
  })
  const { inReplyTo, references } = await threadingOf(port, row)
  return {
    threadId: row.gmailThreadId || null,
    to,
    subject: replySubject(row.subject),
    inReplyTo,
    references,
    text: body,
  }
}

/** `https://mail.google.com/...` link to the draft in the rep's own Gmail. */
export function draftOpenUrl(googleEmail: string | null | undefined, draftMessageId: string | null | undefined): string {
  const authuser = googleEmail && !googleEmail.includes(' ') ? `?authuser=${encodeURIComponent(googleEmail)}` : ''
  return `https://mail.google.com/mail/${authuser}#drafts${draftMessageId ? `?compose=${encodeURIComponent(draftMessageId)}` : ''}`
}
