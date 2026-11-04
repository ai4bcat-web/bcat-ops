/**
 * Step AG §5.4 — free pre-filters before any model call. Stage 1 reads headers + snippet only,
 * stage 2 the body and attachment list. Pure.
 *
 * Unlike the spot quoter, own-domain senders are NOT rejected: AP mail is often an internal
 * "Fwd:" of a carrier invoice, and the invoice sits in the quoted part, so quoted history is
 * never stripped here either.
 */
import type { GmailMessageMeta } from '../spot/port'
import { addressOf } from '../spot/prefilter'
import type { MailboxAttachment } from './mailbox'

export type ApPrefilterVerdict = { pass: true } | { pass: false; reason: string }

export interface ApPrefilterContext {
  /** Lower-case addresses, `@domain` or bare domains (config.ignoreSenders ∪ org blacklist). */
  ignoreSenders: string[]
  /** Lower-case keywords from the org blacklist. */
  ignoreKeywords?: string[]
}

const HARD_LABELS = ['DRAFT', 'SENT', 'SPAM', 'TRASH']
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']
const BOUNCE_SENDER = /^(mailer-daemon|postmaster)(@|$)/
export const INVOICE_TOKEN = /\b(invoice|inv\b|bill\b|billing|statement|remit(tance)?|amount due|balance due|pro\s*#)/i
const AMOUNT = /\$\s?\d[\d,]*\.\d{2}\b/
const REFERENCE = /\b(pro|invoice|inv|ref|reference|bol|load|trip)\s*(#|no\.?|number)?\s*:?\s*[A-Za-z0-9][A-Za-z0-9-]{2,}/i

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 0 ? '' : address.slice(at + 1)
}

export function prefilterApStage1(meta: GmailMessageMeta, ctx: ApPrefilterContext): ApPrefilterVerdict {
  const labels = meta.labelIds ?? []
  if (labels.some((l) => HARD_LABELS.includes(l))) return { pass: false, reason: 'LABEL' }
  const sender = addressOf(meta.from)
  const domain = domainOf(sender)
  if (BOUNCE_SENDER.test(sender)) return { pass: false, reason: 'BOUNCE' }
  const auto = (meta.headers?.['auto-submitted'] ?? '').trim().toLowerCase()
  if (auto === 'auto-replied') return { pass: false, reason: 'AUTO_REPLY' }
  for (const entry of ctx.ignoreSenders) {
    if (sender === entry || (entry.startsWith('@') && domain === entry.slice(1)) || domain === entry) return { pass: false, reason: 'IGNORED_SENDER' }
  }
  const haystack = `${meta.subject ?? ''}\n${meta.snippet ?? ''}`
  const lower = haystack.toLowerCase()
  for (const word of ctx.ignoreKeywords ?? []) if (word && lower.includes(word)) return { pass: false, reason: 'IGNORED_KEYWORD' }
  if (labels.some((l) => BULK_LABELS.includes(l)) && !INVOICE_TOKEN.test(haystack)) return { pass: false, reason: 'BULK' }
  return { pass: true }
}

const MIN_DOC_BYTES = 8 * 1024
const MIN_IMAGE_BYTES = 15 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const isPdf = (a: MailboxAttachment): boolean => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.name)
const isImage = (a: MailboxAttachment): boolean => /^image\/(jpeg|png|webp)/i.test(a.contentType)

/** Stage 2: needs a PDF/image attachment >= 8 KB, or an invoice token plus an amount or a reference. */
export function prefilterApStage2(body: string, attachments: MailboxAttachment[]): ApPrefilterVerdict {
  if (attachments.some((a) => (isPdf(a) || isImage(a)) && a.size >= MIN_DOC_BYTES)) return { pass: true }
  if (INVOICE_TOKEN.test(body) && (AMOUNT.test(body) || REFERENCE.test(body))) return { pass: true }
  return { pass: false, reason: 'NO_INVOICE_SIGNAL' }
}

const NAME_HINT = /inv|bill|stmt|statement|remit|pro/i

/** At most 3 files, <= 8 MB each: PDFs first, invoice-looking names first; images under 15 KB (logos) skipped. */
export function pickInvoiceAttachments(attachments: MailboxAttachment[], max = 3): MailboxAttachment[] {
  return attachments
    .filter((a) => a.size <= MAX_FILE_BYTES && ((isPdf(a) && a.size >= 1) || (isImage(a) && a.size >= MIN_IMAGE_BYTES)))
    .map((a, i) => ({ a, i, rank: (isPdf(a) ? 0 : 2) + (NAME_HINT.test(a.name) ? 0 : 1) }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .slice(0, max)
    .map((x) => x.a)
}
