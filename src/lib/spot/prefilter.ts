/**
 * Step AB §3.2 — deterministic, free pre-filters that run before any body fetch or model
 * call.
 *
 *   Stage 1 (metadata + snippet; the body is never fetched for a reject): internal chatter,
 *     bulk/auto-reply headers, no-reply senders, junk labels, the org blacklist, the rep's
 *     watch label; then needs a freight term OR a known sender.
 *   Stage 2 (body, quoted history stripped): a freight-signal score ≥ 3 with ≥ 1 lane signal.
 *
 * Pure; relative imports only (Lambdas bundle by path).
 */
import type { GmailMessageMeta } from './port'
import { normalizeState } from './normalize'

export interface PrefilterContext {
  repEmail: string
  /** The org's own domains (internal chatter). Lower-case, no `@`. */
  ownDomains: string[]
  blacklist: { addresses: string[]; keywords: string[] }
  /** Only mail carrying this Gmail label is considered; null = whole inbox. */
  watchLabel: string | null
  /** Sender address/domain matches a known `CrmContact`/`CrmDomain`. Relaxes stage 1 only. */
  knownSender: boolean
}

export type PrefilterVerdict = { pass: true } | { pass: false; reason: string }

/** `"Name <a@b.com>"` → `a@b.com`, lower-case. */
export function addressOf(header: string | null | undefined): string {
  const raw = String(header ?? '')
  const angle = raw.match(/<([^<>]+)>/)
  const text = (angle ? angle[1] : raw).trim().toLowerCase()
  return text.replace(/^mailto:/, '')
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 0 ? '' : address.slice(at + 1).replace(/[^a-z0-9.-]/g, '')
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?)(\+|$|[-_.])/
const JUNK_LABELS = ['SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']
const FREIGHT_TERMS =
  /\b(rates?|quotes?|quoting|pric(e|ing)|trucks?|loads?|freight|ftl|ltl|van|reefer|flatbed|step\s?deck|pick-?up|deliver(y|ies)?|lanes?|lbs|pallets?|hauls?|carriers?|shipments?|equipment|availability|per mile|power only|conestoga|sprinter|box truck)\b/i

export function blacklistFromSettings(settingsJsons: unknown[]): { addresses: string[]; keywords: string[] } {
  const addresses: string[] = []
  const keywords: string[] = []
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean) : []
  for (const raw of settingsJsons ?? []) {
    let settings: unknown = raw
    if (typeof raw === 'string') {
      try { settings = JSON.parse(raw) } catch { continue }
    }
    if (!settings || typeof settings !== 'object') continue
    const rec = settings as Record<string, unknown>
    addresses.push(...strings(rec.blacklistAddresses))
    keywords.push(...strings(rec.blacklistKeywords))
  }
  return { addresses, keywords }
}

export function prefilterStage1(meta: GmailMessageMeta, ctx: PrefilterContext): PrefilterVerdict {
  const sender = addressOf(meta.from)
  const senderDomain = domainOfAddress(sender)
  const headers = meta.headers ?? {}
  const rep = (ctx.repEmail ?? '').trim().toLowerCase()

  if (sender === rep || (senderDomain && ctx.ownDomains.some((d) => senderDomain === d || senderDomain.endsWith(`.${d}`)))) {
    return { pass: false, reason: 'INTERNAL' }
  }
  const autoSubmitted = (headers['auto-submitted'] ?? '').trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return { pass: false, reason: 'AUTO_SUBMITTED' }
  if (/\b(bulk|list|junk)\b/i.test(headers['precedence'] ?? '')) return { pass: false, reason: 'BULK' }
  if (headers['list-unsubscribe']) return { pass: false, reason: 'LIST' }
  if (headers['x-autoreply']) return { pass: false, reason: 'AUTO_REPLY' }
  if (NO_REPLY.test(sender.split('@')[0] ?? '')) return { pass: false, reason: 'NO_REPLY' }
  if ((meta.labelIds ?? []).some((l) => JUNK_LABELS.includes(l))) return { pass: false, reason: 'LABEL' }

  const haystack = `${meta.subject ?? ''}\n${meta.snippet ?? ''}`
  const lower = haystack.toLowerCase()
  for (const entry of ctx.blacklist.addresses) {
    if (sender === entry || (entry.startsWith('@') && senderDomain === entry.slice(1)) || senderDomain === entry) {
      return { pass: false, reason: 'BLACKLIST' }
    }
  }
  for (const word of ctx.blacklist.keywords) {
    if (lower.includes(word)) return { pass: false, reason: 'BLACKLIST' }
  }
  if (ctx.watchLabel && !(meta.labelIds ?? []).includes(ctx.watchLabel)) return { pass: false, reason: 'WATCH_LABEL' }

  if (!ctx.knownSender && !FREIGHT_TERMS.test(haystack)) return { pass: false, reason: 'NO_FREIGHT_TERM' }
  return { pass: true }
}

// ── Stage 2 ──────────────────────────────────────────────────────────────────

/**
 * Drops quoted reply history (`>` lines, "On … wrote:", Outlook header blocks, original-message
 * rules) and everything after a signature delimiter or disclaimer, so an old lane in a reply
 * chain is never read as the new request.
 */
export function stripQuotedHistory(text: string): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const t = line.trim()
    if (/^on\b.{0,200}$/i.test(t) && /wrote:\s*$/i.test(`${t} ${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`.trim())) break
    if (/^-{2,}\s*(original message|forwarded message|reply above)/i.test(t)) break
    if (/^_{8,}$/.test(t)) break
    if (/^from:\s/i.test(t)) {
      const next = lines.slice(i + 1, i + 5).map((l) => l.trim())
      if (next.some((l) => /^(sent|date):/i.test(l)) && next.some((l) => /^(to|subject):/i.test(l))) break
    }
    if (/^--\s?$/.test(line)) break
    if (/^(confidentiality notice|confidential:|this e-?mail and any attachments|the information (contained|in this))/i.test(t)) break
    if (t.startsWith('>')) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

const EQUIPMENT_WORD =
  /\b(dry\s?van|van|reefer|flat\s?bed|step\s?deck|power only|conestoga|box truck|sprinter|53\s?'|48\s?'|53\s?(ft|foot)|48\s?(ft|foot))/i
const CITY_STATE = /\b([A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z]{2})\b/g
const STATE_PAIR = /\b([A-Z]{2})\s*(?:to|->|→|-|–)\s*([A-Z]{2})\b/g
const ZIP = /\b\d{5}(?:-\d{4})?\b/g
const REQUEST_WORDING = /\b(rates?|quote|price|pricing|cost|availability|need a (truck|van|trailer)|ftl|per mile|how much|can you cover)\b/i
const LOAD_FACTS = /\b(\d[\d,.]*\s?k?\s?(lbs?|pounds)|pallets?|weight|commodity|pick-?up|deliver(y|ies)?|appt|appointment|ready (on|by))\b/i

export function scoreFreightSignals(text: string): { score: number; laneSignals: number } {
  const body = String(text ?? '')
  const lanes = new Set<string>()
  for (const m of body.matchAll(CITY_STATE)) {
    if (normalizeState(m[2])) lanes.add(`${m[1].toLowerCase()}|${m[2]}`)
  }
  for (const m of body.matchAll(STATE_PAIR)) {
    if (normalizeState(m[1]) && normalizeState(m[2])) lanes.add(`${m[1]}>${m[2]}`)
  }
  for (const m of body.matchAll(ZIP)) lanes.add(`zip|${m[0].slice(0, 5)}`)
  const laneSignals = lanes.size
  let score = 0
  if (EQUIPMENT_WORD.test(body)) score += 1
  if (laneSignals >= 2) score += 1
  if (REQUEST_WORDING.test(body)) score += 1
  if (LOAD_FACTS.test(body)) score += 1
  return { score, laneSignals }
}

/** Pass at score ≥ 3 with at least one lane signal. Call with `stripQuotedHistory` output. */
export function prefilterStage2(text: string): PrefilterVerdict & { score: number } {
  const { score, laneSignals } = scoreFreightSignals(text)
  if (laneSignals < 1) return { pass: false, reason: 'NO_LANE', score }
  if (score < 3) return { pass: false, reason: 'LOW_SCORE', score }
  return { pass: true, score }
}
