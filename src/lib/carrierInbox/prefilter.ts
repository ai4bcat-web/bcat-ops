/**
 * Step AL §5.2 — the free, deterministic funnel in front of the model. Stage 1 sees headers
 * only (the body is never fetched for a stage-1 reject); stage 2 sees the quoted-history-stripped
 * body. Mail that fails either stage is counted and dropped, never stored. Pure.
 */
import type { GmailMessageMeta } from '../spot/port'
import { addressOf, scoreFreightSignals, stripQuotedHistory } from '../spot/prefilter'
import { authPasses } from '../workflows/partyMatch'
import { hasReferenceToken } from './refs'
import type { CarrierInboxMailbox, ResolvedCarrierInboxConfig } from './types'

export interface Stage1Verdict {
  pass: boolean
  /** `WRONG_MAILBOX` = not addressed to this mailbox's distribution address / label. */
  reason?: string
  /** Provider name when the sender is a load-board relay, else null. */
  boardProvider: string | null
}

const DROP_LABELS = ['DRAFT', 'SENT', 'SPAM', 'TRASH']
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']
const MACHINE_SENDER = /^(mailer-daemon|postmaster)(\+|$|[-_.])/
const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|notifications?)(\+|$|[-_.])/

const BOARD_NAMES: Record<string, string> = {
  'dat.com': 'DAT',
  'truckstop.com': 'TRUCKSTOP',
  '123loadboard.com': '123LOADBOARD',
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1)

/** `loads+ZZ1@x.com` and `loads.bids.ZZ1@x.com` both address `loads@x.com`. */
function baseAddress(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0) return address
  const local = address.slice(0, at).replace(/\+.*$/, '').replace(/\.bids\..*$/, '')
  return `${local}${address.slice(at)}`
}

function headerAddresses(value: string | undefined): string[] {
  return (value ?? '').split(',').map(addressOf).filter(Boolean)
}

function boardProviderOf(senderDomain: string, boardDomains: string[]): string | null {
  const hit = boardDomains.find((d) => senderDomain === d || senderDomain.endsWith(`.${d}`))
  if (!hit) return null
  return BOARD_NAMES[hit] ?? (hit.split('.')[0] ?? hit).toUpperCase()
}

export function prefilterStage1(
  meta: GmailMessageMeta,
  cfg: ResolvedCarrierInboxConfig,
  mailbox: CarrierInboxMailbox,
  blacklist: { addresses: string[]; keywords: string[] },
): Stage1Verdict {
  const sender = addressOf(meta.from)
  const senderDomain = domainOf(sender)
  const board = boardProviderOf(senderDomain, cfg.boardSenderDomains)
  const headers = meta.headers ?? {}
  const labels = meta.labelIds ?? []
  const drop = (reason: string): Stage1Verdict => ({ pass: false, reason, boardProvider: board })

  // Addressed to this mailbox's distribution address, or carrying its Gmail label.
  const wanted = mailbox.addresses.map((a) => baseAddress(a.trim().toLowerCase()))
  const seen = [...meta.to, ...meta.cc, ...headerAddresses(headers['delivered-to']), ...headerAddresses(headers['x-original-to'])]
    .map((a) => baseAddress(addressOf(a)))
  const addressed = wanted.length > 0 && seen.some((a) => wanted.includes(a))
  const labelled = !!mailbox.gmailLabel && labels.includes(mailbox.gmailLabel)
  if (!addressed && !labelled) return drop('WRONG_MAILBOX')

  if (labels.some((l) => DROP_LABELS.includes(l))) return drop('LABEL')
  const autoSubmitted = (headers['auto-submitted'] ?? '').trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return drop('AUTO_SUBMITTED')
  if (headers['x-autoreply']) return drop('AUTO_REPLY')

  const local = sender.split('@')[0] ?? ''
  if (MACHINE_SENDER.test(local) || (!board && NO_REPLY.test(local))) return drop('NO_REPLY')
  // Load-board relays are bulk-shaped by nature; the board exception covers exactly these.
  if (!board) {
    if (/\b(bulk|list|junk)\b/i.test(headers['precedence'] ?? '')) return drop('BULK')
    if (headers['list-unsubscribe']) return drop('LIST')
    if (labels.some((l) => BULK_LABELS.includes(l))) return drop('LABEL')
  }

  // Our own mailboxes and distribution addresses (loops). Own-DOMAIN senders are kept: a rep
  // forwarding a carrier's mail to the desk is a legitimate path.
  for (const m of cfg.mailboxes) {
    if (sender === m.account.toLowerCase() || m.addresses.some((a) => baseAddress(a.toLowerCase()) === baseAddress(sender))) {
      return drop('OWN_MAILBOX')
    }
  }

  const haystack = `${meta.subject ?? ''}\n${meta.snippet ?? ''}`.toLowerCase()
  for (const raw of [...cfg.ignoreSenders, ...blacklist.addresses]) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (sender === entry || senderDomain === entry.replace(/^@/, '')) return drop('BLACKLIST')
  }
  if (blacklist.keywords.some((w) => w && haystack.includes(w))) return drop('BLACKLIST')

  return { pass: true, boardProvider: board }
}

// ── Stage 2 ──────────────────────────────────────────────────────────────────

/** A forward carries the carrier's words in the quoted part, so `Fwd:`/`FW:` is not stripped. */
export function prepareInboundBody(subject: string | null, text: string): string {
  return /^\s*(?:fwd?|fw)\s*:/i.test(subject ?? '') ? String(text ?? '').trim() : stripQuotedHistory(text)
}

const PRICE = /\$\s*\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d+)?\s*(?:usd|dollars|all[- ]?in)\b|\b(?:rate|offer|bid|price|per mile)\b[^.\n]{0,24}\d/i
const IDENTITY = /\b(?:mc|dot|usdot)\s*(?:#|no\.?)?\s*[-:]?\s*\d{3,}/i
const CARRIER_CUE = /\b(trucks?|available|interested|cover(?:ing)?|carrier|driver|dispatch|mc|dot|bid|withdraw|booked|covered|filled)\b/i

/**
 * Pass iff (a price and one of {reference token, MC/DOT, lane pair}) or (a reference token and a
 * carrier cue), or the sender is a load-board relay. Call with `prepareInboundBody` output.
 */
export function prefilterStage2(text: string, opts: { boardRelay?: boolean } = {}): { pass: boolean; score: number } {
  const body = String(text ?? '')
  const price = PRICE.test(body)
  const reference = hasReferenceToken(body)
  const identity = IDENTITY.test(body)
  const lane = scoreFreightSignals(body).laneSignals >= 2
  const cue = CARRIER_CUE.test(body)
  const score = [price, reference, identity, lane, cue].filter(Boolean).length
  const pass = !!opts.boardRelay || (price && (reference || identity || lane)) || (reference && cue)
  return { pass, score }
}

/** SPF/DKIM pass aligned with the From domain (`Authentication-Results`); absent header = false. */
export function authOkFromHeaders(headers: Record<string, string> | undefined, fromHeader: string): boolean {
  const verdict = headers?.['authentication-results'] ?? ''
  return !!verdict && authPasses(verdict, domainOf(addressOf(fromHeader)))
}
