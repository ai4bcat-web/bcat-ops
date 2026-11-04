/**
 * Step AG §5.4 — post-processing of the model's output. The model is never trusted for a
 * format: sentinels become null, dates are validated against the mail date, money becomes integer
 * cents exactly once (`centsFromDollars`), PROs go through `normalizePro`.
 *
 * Union-free by construction (`RawApModelOutput`): Anthropic structured output refuses many union
 * types, so every leaf is a plain string / number / array and absence is `''` / `-1`.
 */
import { normalizePro } from '../proNumber'
import { centsFromDollars } from '../workflows/apProposal'
import { stripControl } from '../spot/text'
import { digitsOf } from './refs'
import type { ApConfidence, ApExtraction, ApMailKind } from './types'

export interface RawApModelOutput {
  kind: string
  confidence: string
  reason: string
  issuerName: string
  issuerKind: string
  mcNumber: string
  dotNumber: string
  proNumbers: string[]
  otherRefs: string[]
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  /** -1 = not stated. */
  termsDays: number
  /** Total due in dollars, -1 = not stated. */
  amountDollars: number
  remitToName: string
  remitToText: string
  notes: string
  lowConfidence: string[]
}

const DAY_MS = 86_400_000
const KINDS: readonly ApMailKind[] = ['INVOICE', 'CREDIT_MEMO', 'STATEMENT', 'PAYMENT_NOTICE', 'OTHER']

/** The union-free JSON schema the model must answer with (`additionalProperties:false`, every key required). */
export const AP_INBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
    issuerName: { type: 'string' },
    issuerKind: { type: 'string', enum: ['CARRIER', 'VENDOR', 'UNKNOWN'] },
    mcNumber: { type: 'string' },
    dotNumber: { type: 'string' },
    proNumbers: { type: 'array', items: { type: 'string' } },
    otherRefs: { type: 'array', items: { type: 'string' } },
    invoiceNumber: { type: 'string' },
    invoiceDate: { type: 'string' },
    dueDate: { type: 'string' },
    termsDays: { type: 'number' },
    amountDollars: { type: 'number' },
    remitToName: { type: 'string' },
    remitToText: { type: 'string' },
    notes: { type: 'string' },
    lowConfidence: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'kind', 'confidence', 'reason', 'issuerName', 'issuerKind', 'mcNumber', 'dotNumber', 'proNumbers',
    'otherRefs', 'invoiceNumber', 'invoiceDate', 'dueDate', 'termsDays', 'amountDollars', 'remitToName',
    'remitToText', 'notes', 'lowConfidence',
  ],
} as const

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = stripControl(value).replace(/\s{2,}/g, ' ').trim()
  return t === '' ? null : t.slice(0, max)
}

function realDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null
  const iso = value.trim()
  const at = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== iso ? null : iso
}

const ms = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime()

/** Digit runs of 6+ (account / routing numbers) are removed from anything we store. */
export function stripLongDigitRuns(value: string): string {
  return value.replace(/\d[\d\s-]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '' : m)).replace(/\s{2,}/g, ' ').trim()
}

function list(values: unknown, max: number, map: (v: string) => string | null): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== 'string') continue
    const m = map(v)
    if (m && !out.includes(m)) out.push(m)
    if (out.length >= max) break
  }
  return out
}

/** `mailDate` is the message's ISO date (`YYYY-MM-DD`) — relative sanity checks hang off it. */
export function normalizeApExtraction(raw: RawApModelOutput, ctx: { mailDate: string }): ApExtraction {
  const low: string[] = list(raw.lowConfidence, 10, (s) => text(s, 40))
  const kind: ApMailKind = KINDS.includes(raw.kind as ApMailKind) ? (raw.kind as ApMailKind) : 'OTHER'
  const confidence: ApConfidence = raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low'
  const mail = realDate(ctx.mailDate) ?? new Date().toISOString().slice(0, 10)

  let invoiceDate = realDate(raw.invoiceDate)
  if (raw.invoiceDate && !invoiceDate) low.push('invoiceDate')
  if (invoiceDate && (ms(invoiceDate) > ms(mail) + DAY_MS || ms(invoiceDate) < ms(mail) - 400 * DAY_MS)) {
    invoiceDate = null
    low.push('invoiceDate')
  }

  let dueDate = realDate(raw.dueDate)
  if (raw.dueDate && !dueDate) low.push('dueDate')
  if (dueDate) {
    const lo = invoiceDate ? ms(invoiceDate) : ms(mail) - 400 * DAY_MS
    const hi = (invoiceDate ? ms(invoiceDate) : ms(mail)) + 180 * DAY_MS
    if (ms(dueDate) < lo || ms(dueDate) > hi) {
      dueDate = null
      low.push('dueDate')
    }
  }

  const terms = typeof raw.termsDays === 'number' && Number.isInteger(raw.termsDays) && raw.termsDays >= 0 && raw.termsDays <= 180
    ? raw.termsDays
    : null
  const amount = typeof raw.amountDollars === 'number' && raw.amountDollars > 0 ? centsFromDollars(raw.amountDollars) : null
  const remitName = text(raw.remitToName, 120)
  const remitText = text(stripLongDigitRuns(typeof raw.remitToText === 'string' ? raw.remitToText : ''), 300)
  const issuerName = text(raw.issuerName, 120)
  const issuerKind = raw.issuerKind === 'CARRIER' || raw.issuerKind === 'VENDOR' ? raw.issuerKind : 'UNKNOWN'

  return {
    kind,
    confidence,
    reason: text(raw.reason, 300) ?? '',
    issuer: { name: issuerName, kind: issuerKind, mc: digitsOf(raw.mcNumber), dot: digitsOf(raw.dotNumber) },
    pros: list(raw.proNumbers, 5, (s) => normalizePro(s)),
    otherRefs: list(raw.otherRefs, 5, (s) => text(s, 40)),
    invoiceNumber: text(raw.invoiceNumber, 64),
    invoiceDate,
    dueDate,
    termsDays: terms,
    amountCents: amount,
    remitTo: remitName || remitText ? { name: remitName, text: remitText } : null,
    notes: text(raw.notes, 300),
    lowConfidence: [...new Set(low)],
  }
}
