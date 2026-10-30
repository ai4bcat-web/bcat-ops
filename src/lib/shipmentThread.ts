/**
 * Step P8 / N4 — one e-mail thread per shipment.
 *
 * Ryne's answer picks route (b) for the demo: the app's own bridged Gmail,
 * `ai4bcat@gmail.com`, with plus addresses routed by the existing Apps Script →
 * webhook bridge. So a shipment's reply address is a plus address on that mailbox,
 * and the shipment id is the thing after the plus — which means an inbound reply
 * can be matched to a shipment from its `To:` line alone, with no table lookup and
 * no guessing from the subject.
 *
 * `Message-ID` and `In-Reply-To` are real RFC-5322 headers so a carrier's mail
 * client threads our messages the way it threads anyone's, and so the bridge can
 * stitch a reply onto the right message even when the plus address is stripped by
 * a mailing list.
 */

/** The inbox the bridge delivers to. Routes by plus address, not by domain. */
export const THREAD_MAILBOX = 'ai4bcat@gmail.com'

/** The four Step K inbox roles that reach this mailbox by plus address. */
export const INBOX_PLUS_ROLES: Record<string, 'QUOTE' | 'TENDER' | 'CARRIER' | 'TRACKING'> = {
  quotes: 'QUOTE',
  tenders: 'TENDER',
  carriers: 'CARRIER',
  tracking: 'TRACKING',
}

/** The thread key a shipment's messages all carry. */
export function threadKeyFor(shipmentId: string): string {
  return `tracking+${shipmentId}`
}

/** The reply-to address for a shipment's thread, on the bridged mailbox. */
export function threadReplyAddress(shipmentId: string, mailbox = THREAD_MAILBOX): string {
  const [local, domain] = mailbox.split('@')
  return `${local}+tracking.${shipmentId}@${domain}`
}

/**
 * The shipment a delivered message belongs to, read from the addresses it carried.
 *
 * Checks every recipient, because a reply usually lands with our address in `To:`
 * but a reply-all puts it in `Cc:` just as often. Returns null rather than a guess.
 */
export function shipmentIdFromAddresses(addresses: readonly (string | null | undefined)[]): string | null {
  for (const raw of addresses) {
    if (!raw) continue
    for (const part of String(raw).split(/[,;]/)) {
      const match = /\+tracking\.([A-Za-z0-9_-]+)@/.exec(part)
      if (match) return match[1]
    }
  }
  return null
}

/** The Step K inbox role a plus-addressed message is for, or null when it is not one. */
export function inboxRoleFromAddresses(
  addresses: readonly (string | null | undefined)[],
): 'QUOTE' | 'TENDER' | 'CARRIER' | 'TRACKING' | null {
  for (const raw of addresses) {
    if (!raw) continue
    for (const part of String(raw).split(/[,;]/)) {
      const match = /\+([a-z]+)@/.exec(part.toLowerCase())
      const role = match ? INBOX_PLUS_ROLES[match[1]] : undefined
      if (role) return role
    }
  }
  return null
}

/**
 * A new RFC-5322 Message-ID for a message we are sending.
 *
 * The shipment id is inside it on purpose: a bounced or forwarded reply that keeps
 * only `In-Reply-To` still names its shipment.
 */
export function newMessageId(shipmentId: string, seq: number, domain = 'bcatcorp.com'): string {
  return `<s.${shipmentId}.${seq}.${Date.now().toString(36)}@${domain}>`
}

/** The shipment id inside one of our own Message-IDs, when it is one of ours. */
export function shipmentIdFromMessageId(messageId: string | null | undefined): string | null {
  if (!messageId) return null
  const match = /^<s\.([A-Za-z0-9_-]+)\./.exec(messageId.trim())
  return match ? match[1] : null
}

/** The subject every message on a shipment's thread carries, so a client groups them. */
export function threadSubject(shipmentNumber: string, lane: string | null | undefined): string {
  return lane ? `Load ${shipmentNumber} — ${lane}` : `Load ${shipmentNumber}`
}

/** `Re:` once, however many rounds the thread runs. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`
}

/**
 * Step P8 — filter a shipment's full message history down to the tracking-only
 * conversation. Hides offers, quotes and tender messages; starts at the first
 * rate confirmation. The raw list (sorted oldest‑first) is what the server
 * returns; what goes home is the tracking thread.
 */
const TRACKING_HIDDEN_KINDS = new Set(['CARRIER_OFFER', 'QUOTE', 'TENDER'])

export function trackingThreadMessages<T extends { kind: string; at: string }>(messages: readonly T[]): T[] {
  const sorted = [...messages].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  // Drop the offer/quote/tender kinds.
  const visible = sorted.filter((m) => !TRACKING_HIDDEN_KINDS.has(m.kind))
  // Start at the first rate confirmation, if one exists.
  const firstRateIdx = visible.findIndex((m) => m.kind === 'RATE_CON')
  if (firstRateIdx >= 0) return visible.slice(firstRateIdx)
  // No rate confirmation yet: show everything that remains.
  return visible
}
