/**
 * tms-spot-quoter — the SUGGESTED RESPONSE the rep may copy (read-only mailbox, Ryne
 * 2026-11-04). It is rendered from the Quote row or the stored suggestion and validated
 * fields only (`renderSpotReply` takes enums, numbers, dates and the minted link; model free
 * text is not an input, so an instruction injected into a customer mail cannot reach it).
 * Nothing here talks to Gmail: the rep pastes it, or opens a compose window prefilled by URL.
 */
import type { GmailRepSettings, SpotExtraction, SpotRequestRecord } from '../../../src/types/tms'
import { renderSpotReply, replySubject } from '../../../src/lib/spot/replyTemplate'
import type { SpotSuggestedResponse } from '../../../src/lib/spot/types'
import type { SpotDeps } from './deps'
import { jsonOf, type Row } from './store'

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

/** One line, no control characters: safe in a URL and in a mail header the rep may paste into. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function buildSuggestedResponse(
  deps: Pick<SpotDeps, 'portalOrigin'>,
  row: SpotRequestRecord,
  quote: Row | null,
  repSettings: Pick<GmailRepSettings, 'signature'>,
  text: { intro?: string | null; outro?: string | null; googleEmail?: string | null } = {},
): SpotSuggestedResponse {
  const to = oneLine(recipientOf(row))
  if (!to) throw new Error('This request has no reply address.')
  const extraction = row.extraction ?? null
  const suggestion = jsonOf<{ suggestedCents?: number }>(row.suggestion)
  const rateCents = quote ? Number(quote.amountCents ?? 0) : Number(suggestion?.suggestedCents ?? 0)
  if (!(rateCents > 0)) throw new Error('There is no price yet: price the quote first.')
  const link = quote ? quoteLink(deps, quote) : ''
  const { origin, destination } = endpoints(extraction)
  const body = renderSpotReply({
    rateCents,
    origin,
    destination,
    equipmentType: String(quote?.equipmentType ?? extraction?.equipmentType ?? 'VAN'),
    lengthFt: typeof quote?.equipmentLengthFt === 'number' ? quote.equipmentLengthFt : extraction?.lengthFt ?? null,
    pickupDate: extraction?.pickupDate ?? null,
    expiresAt: typeof quote?.expiresAt === 'string' ? quote.expiresAt : null,
    link,
    intro: text.intro,
    outro: text.outro,
    signature: repSettings.signature,
  })
  const subject = replySubject(row.subject)
  const enc = encodeURIComponent
  const authuser = text.googleEmail && !text.googleEmail.includes(' ') ? `&authuser=${enc(text.googleEmail)}` : ''
  return {
    to,
    subject,
    body,
    mailto: `mailto:${enc(to)}?subject=${enc(subject)}&body=${enc(body)}`,
    gmailUrl: `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}${authuser}`,
    rateCents,
    hasLink: Boolean(link),
  }
}
