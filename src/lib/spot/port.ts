/**
 * Step AB §9.2 — the Gmail wire, as the spot pipeline sees it. READ-ONLY (Ryne, 2026-11-04): the
 * port has no draft, send or modify method; the app never writes to a mailbox.
 *
 * Implemented by `amplify/functions/_shared/gmail/googlePort.ts` (REST over fetch with a
 * per-rep bearer token) and `simPort.ts` (S3-backed simulated inbox, dev only). Both
 * satisfy `amplify/functions/_shared/gmail/contract.test.ts`.
 */

export interface GmailMessageMeta {
  id: string
  threadId: string
  /** Epoch milliseconds as a string, Gmail's own `internalDate`. */
  internalDate: string
  from: string
  to: string[]
  cc: string[]
  replyTo: string | null
  subject: string
  messageId: string
  inReplyTo: string | null
  references: string | null
  snippet: string
  labelIds: string[]
  /** Only the allow-listed headers, keyed by lower-case name. */
  headers: Record<string, string>
}

export interface GmailPort {
  profile(): Promise<{ emailAddress: string; historyId: string }>
  listRecent(o: { lookbackDays: number; label: string | null; max: number }): Promise<string[]>
  listSince(
    historyId: string,
    o: { label: string | null; max: number },
  ): Promise<{ ids: string[]; historyId: string } | { expired: true }>
  getMetadata(id: string): Promise<GmailMessageMeta>
  /** text/plain preferred; HTML stripped. */
  getBody(id: string): Promise<{
    text: string
    attachments: { name: string; contentType: string; size: number }[]
  }>
  threadMessages(threadId: string): Promise<GmailMessageMeta[]>
}

/** Header names the port keeps in `GmailMessageMeta.headers` (lower-case). */
export const GMAIL_HEADER_ALLOWLIST = [
  'list-unsubscribe',
  'precedence',
  'auto-submitted',
  'x-autoreply',
  'authentication-results',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  // Step AL: the carrier-sales stage-1 filter matches the distribution address here when a
  // forward or Google Group rewrites To/Cc.
  'delivered-to',
  'x-original-to',
] as const
