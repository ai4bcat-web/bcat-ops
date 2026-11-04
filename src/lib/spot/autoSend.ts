/**
 * Step AB §4.7 — the pure auto-send decision. `allow` is true only when EVERY gate holds;
 * each failing gate adds exactly its reason code. Dev stack adds `DEV_STACK` but every other
 * gate is still evaluated (the request becomes a normal draft with `wouldSend`).
 * Auto-send is off by default at org and rep level (Ryne R1). Pure; relative imports only.
 */
import type { GmailRepSettings, SpotExtraction, SpotFieldMeta, SpotMatchHow } from '../../types/tms'
import { hasSpecialHandling } from './accessorials'
import { fieldStatusOf } from './fields'
import { REQUIRED_SPOT_FIELDS } from './normalize'
import type { ResolvedSpotSettings } from './settings'
import type { AutoSendDecision, AutoSendReason, SpotSuggestion } from './types'

export const AUTO_SEND_MAX_WEIGHT_LBS = 45_000

export interface AutoSendContext {
  settings: ResolvedSpotSettings
  repSettings: GmailRepSettings
  devStack: boolean
  repId: string
  customer: {
    status: string | null
    accountOwnerIds: string[] | null
    defaultSalesRepId: string | null
  } | null
  matchHow: SpotMatchHow | null
  /** `resolveMargin(...).autoReply` — the customer's opt-in, else the org default. */
  customerAutoReply: boolean
  extraction: SpotExtraction
  fieldMeta: SpotFieldMeta
  suggestion: SpotSuggestion | null
  senderAuthOk: boolean
  threadHasOutbound: boolean
  replyTo: string | null
  hasQuoteOrDraft: boolean
  autoSentTodayRep: number
  autoSentTodayCustomer: number
}

export function autoSendDecision(c: AutoSendContext): AutoSendDecision {
  const reasons: AutoSendReason[] = []
  const fail = (r: AutoSendReason) => {
    if (!reasons.includes(r)) reasons.push(r)
  }

  if (!c.settings.enabled || !c.settings.allowAutoSend) fail('ORG_OFF')
  if (!c.repSettings.autoSend) fail('REP_OFF')

  if (!c.customer) fail('NO_CUSTOMER')
  else {
    if (c.matchHow !== 'EMAIL') fail('MATCH_NOT_EXACT')
    if (c.customer.status !== 'ACTIVE') fail('CUSTOMER_NOT_ACTIVE')
    const owners = c.customer.accountOwnerIds ?? []
    if (!owners.includes(c.repId) && c.customer.defaultSalesRepId !== c.repId) fail('NOT_OWNER')
  }
  if (!c.customerAutoReply) fail('CUSTOMER_OPT_OUT')

  const e = c.extraction
  const fieldsOk = REQUIRED_SPOT_FIELDS.every((key) => {
    const status = fieldStatusOf(key, e, c.fieldMeta)
    return status === 'CONFIRMED' || (status === 'AUTO' && c.fieldMeta[key]?.confidence === 'high')
  })
  if (!fieldsOk) fail('FIELD_NOT_HIGH')
  if (e.mode !== 'FTL') fail('MODE_NOT_FTL')
  if ((e.accessorials ?? []).length > 0) fail('ACCESSORIALS')
  if (hasSpecialHandling(e) || (e.weightLbs != null && e.weightLbs > AUTO_SEND_MAX_WEIGHT_LBS)) fail('SPECIAL_HANDLING')

  const s = c.suggestion
  if (!s || s.basis === 'STUB' || s.stub) fail('PRICE_STUB')
  else if (s.basis === 'HISTORY' && s.sampleCount < c.settings.autoSendMinSamples) fail('PRICE_THIN')
  if (s && (s.belowFloor || (s.floorSellCents > 0 && s.suggestedCents < s.floorSellCents))) fail('BELOW_FLOOR')

  if (!c.senderAuthOk) fail('SENDER_AUTH')
  if (c.threadHasOutbound) fail('THREAD_NOT_NEW')
  if (!c.replyTo || !c.replyTo.includes('@')) fail('NO_RECIPIENT')
  if (c.hasQuoteOrDraft) fail('DUPLICATE')
  if (c.autoSentTodayRep >= c.settings.autoSendDailyCapPerRep) fail('CAP_REP')
  if (c.autoSentTodayCustomer >= c.settings.autoSendDailyCapPerCustomer) fail('CAP_CUSTOMER')
  if (c.devStack) fail('DEV_STACK')

  return { allow: reasons.length === 0, reasons }
}

/** The Chicago calendar day (`YYYY-MM-DD`) of an instant — the daily-cap boundary. */
export function chicagoDay(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@')
  return (at < 0 ? address : address.slice(at + 1)).replace(/[^a-z0-9.-]/gi, '').toLowerCase()
}

function aligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/**
 * SPF **and** DKIM both `pass` in `Authentication-Results`, each aligned with the sender
 * domain where the header names a domain. A missing verdict is a fail.
 */
export function senderAuthPasses(headers: Record<string, string>, fromEmail: string): boolean {
  const results = (headers?.['authentication-results'] ?? '').toLowerCase()
  const from = domainOfAddress(fromEmail ?? '')
  if (!results || !from) return false
  const spf = results.match(/\bspf=(\w+)/)
  const dkim = results.match(/\bdkim=(\w+)/)
  if (spf?.[1] !== 'pass' || dkim?.[1] !== 'pass') return false
  const dkimDomain = results.match(/header\.(?:d|i)=@?([a-z0-9.-]+)/)?.[1]
  if (dkimDomain && !aligned(from, dkimDomain.replace(/^.*@/, ''))) return false
  const spfDomain = results.match(/smtp\.(?:mailfrom|helo)=(?:[^@\s;]*@)?([a-z0-9.-]+)/)?.[1]
  if (spfDomain && !aligned(from, spfDomain)) return false
  return true
}
