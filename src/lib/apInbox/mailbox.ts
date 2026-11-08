/**
 * Step AG §4 — the one seam the AP-inbox pipeline sees. READ-ONLY: GmailPort plus two read
 * methods. There is no draft, send, label or modify method anywhere (the app never writes to a
 * mailbox), and nothing is marked read — the cursor is a timestamp, not mailbox state.
 *
 * Implemented by `amplify/functions/_shared/gmail/{googlePort,simPort}.ts`.
 */
import type { GmailPort } from '../spot/port'

export interface MailboxAttachment {
  name: string
  contentType: string
  size: number
  /** Gmail attachmentId; absent for inline parts and for the simulated inbox. */
  id?: string
}

export interface MailboxPort extends Omit<GmailPort, 'getBody'> {
  getBody(id: string): Promise<{ text: string; attachments: MailboxAttachment[] }>
  /**
   * Message ids with internalDate >= afterMs (inclusive; the caller dedupes the boundary), any
   * label except SENT / DRAFT / SPAM / TRASH. Oldest first, at most `max` (the OLDEST `max`, so a
   * capped run leaves the newer mail for the next slice and the cursor never skips a message).
   */
  listAfter(o: { afterMs: number; max: number }): Promise<string[]>
  /** The decoded bytes of one attachment (<= 25 MB), or null when it is gone. Never logs content. */
  getAttachment(messageId: string, att: MailboxAttachment): Promise<Buffer | null>
}

/** Method names a read-only port must never expose (asserted by the adapter contract test). */
export const FORBIDDEN_MAILBOX_METHODS = /send|draft|modify|trash|label|delete|insert/i
