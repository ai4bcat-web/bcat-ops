/**
 * Step V — tracking automation: may the agent send on its own, to whom, when, and
 * with what text. Pure (no React, no AWS); the Lambda imports it by relative path.
 *
 * Two layers, no duplicated cadence:
 *   plan   (CheckCallPlan, whole-plan override)  load → customer → division → org → default
 *   policy (AutomationPolicy, field-level merge)  default ← global ← division ← subdivision ← customer
 */
import {
  DEFAULT_CHECK_CALL_PLAN,
  normalizeCheckCallPlan,
  type CheckCallPlan,
  type CheckCallPlanSource,
} from './checkCallPlan'
import { TZ } from './date'
import { MAX_SMS_BODY } from './dispatch'
import type { RateConStatus } from '../types/tms'

export type AutomationChannel = 'SMS' | 'EMAIL'
export const AUTOMATION_CHANNELS: readonly AutomationChannel[] = ['SMS', 'EMAIL']

export interface QuietHours {
  enabled: boolean
  /** 'HH:mm' 24h, local to `timezone`. */
  start: string
  /** 'HH:mm'; end <= start means the window crosses midnight. */
  end: string
  /** IANA zone. */
  timezone: string
  /** Which channels the window silences. */
  channels: AutomationChannel[]
}

export const TEMPLATE_KEYS = [
  'checkCallSms', 'checkCallEmailSubject', 'checkCallEmailBody',
  'podSms', 'podEmailSubject', 'podEmailBody',
] as const
export type TemplateKey = (typeof TEMPLATE_KEYS)[number]
export type AutomationTemplates = Record<TemplateKey, string>

export const TEMPLATE_PLACEHOLDERS = [
  'proNumber', 'loadNumber', 'origin', 'destination', 'pickupDate', 'deliveryDate',
  'customer', 'carrier', 'driverName', 'lastLocation', 'trackerName', 'trackerPhone', 'trackingUrl',
] as const
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number]

export interface AutomationPolicy {
  checkCallsAuto: boolean
  podAuto: boolean
  podChannels: AutomationChannel[]
  quietHours: QuietHours
  templates: AutomationTemplates
}
/** A layer: any subset of keys. Absent key = inherit. `templates` merges per key, `quietHours` as a whole. */
export type AutomationPolicyPatch = Partial<Omit<AutomationPolicy, 'templates'>> & { templates?: Partial<AutomationTemplates> }

export interface DivisionAutomation { policy?: AutomationPolicyPatch; plan?: CheckCallPlan | null }
export interface TrackingAutomationSettings {
  global: AutomationPolicyPatch
  /** key = OwnershipDivision.code */
  divisions: Record<string, DivisionAutomation>
}

const EMPTY_TEMPLATES: AutomationTemplates = {
  checkCallSms: '', checkCallEmailSubject: '', checkCallEmailBody: '',
  podSms: '', podEmailSubject: '', podEmailBody: '',
}

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  checkCallsAuto: false,
  podAuto: false,
  podChannels: ['SMS', 'EMAIL'],
  quietHours: { enabled: true, start: '21:00', end: '06:00', timezone: TZ, channels: ['SMS'] },
  templates: EMPTY_TEMPLATES,
}
export const EMPTY_TRACKING_AUTOMATION: TrackingAutomationSettings = { global: {}, divisions: {} }

const MAX_TEMPLATE_CHARS = 4000
const MAX_DIVISIONS = 200
const MAX_DIVISION_CODE = 64
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function asRecord(raw: unknown): Record<string, unknown> | null {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function channelList(raw: unknown): AutomationChannel[] | null {
  if (!Array.isArray(raw)) return null
  return AUTOMATION_CHANNELS.filter((c) => raw.includes(c))
}

function normalizeQuietHours(raw: unknown): QuietHours | undefined {
  const row = asRecord(raw)
  if (!row) return undefined
  const d = DEFAULT_AUTOMATION_POLICY.quietHours
  return {
    enabled: typeof row.enabled === 'boolean' ? row.enabled : d.enabled,
    start: typeof row.start === 'string' && HHMM.test(row.start) ? row.start : d.start,
    end: typeof row.end === 'string' && HHMM.test(row.end) ? row.end : d.end,
    timezone: isValidTimeZone(row.timezone) ? row.timezone : d.timezone,
    channels: channelList(row.channels) ?? [...d.channels],
  }
}

/** Read stored JSON/object; drop unknown keys; clamp; never throws (returns {} on junk). */
export function normalizeAutomationPatch(raw: unknown): AutomationPolicyPatch {
  const row = asRecord(raw)
  const out: AutomationPolicyPatch = {}
  if (!row) return out
  if (typeof row.checkCallsAuto === 'boolean') out.checkCallsAuto = row.checkCallsAuto
  if (typeof row.podAuto === 'boolean') out.podAuto = row.podAuto
  const podChannels = channelList(row.podChannels)
  if (podChannels) out.podChannels = podChannels
  const quiet = normalizeQuietHours(row.quietHours)
  if (quiet) out.quietHours = quiet
  const templates = asRecord(row.templates)
  if (templates) {
    const t: Partial<AutomationTemplates> = {}
    for (const key of TEMPLATE_KEYS) {
      const v = templates[key]
      if (typeof v === 'string') t[key] = v.slice(0, MAX_TEMPLATE_CHARS)
    }
    if (Object.keys(t).length) out.templates = t
  }
  return out
}

/** Same for the settings blob; division codes trimmed, ≤64 chars, ≤200 divisions. */
export function normalizeTrackingAutomation(raw: unknown): TrackingAutomationSettings {
  const row = asRecord(raw)
  const result: TrackingAutomationSettings = { global: {}, divisions: {} }
  if (!row) return result
  result.global = normalizeAutomationPatch(row.global)
  const divisions = asRecord(row.divisions)
  if (divisions) {
    let count = 0
    for (const [rawCode, value] of Object.entries(divisions)) {
      const code = rawCode.trim()
      if (!code || code.length > MAX_DIVISION_CODE || UNSAFE_KEYS.has(code)) continue
      if (count >= MAX_DIVISIONS) break
      const entry = asRecord(value)
      if (!entry) continue
      const division: DivisionAutomation = {}
      const policy = normalizeAutomationPatch(entry.policy)
      if (Object.keys(policy).length) division.policy = policy
      const plan = normalizeCheckCallPlan(entry.plan)
      if (plan) division.plan = plan
      if (!division.policy && !division.plan) continue
      result.divisions[code] = division
      count += 1
    }
  }
  return result
}

/** Strict variant for WRITES: throws Error with a user-readable message. */
export function validateAutomationPatch(raw: unknown): AutomationPolicyPatch {
  if (raw == null) return {}
  const row = asRecord(raw)
  if (!row) throw new Error('Automation settings must be an object')
  for (const key of ['checkCallsAuto', 'podAuto'] as const) {
    if (row[key] != null && typeof row[key] !== 'boolean') throw new Error(`${key} must be true or false`)
  }
  if (row.podChannels != null) {
    if (!Array.isArray(row.podChannels) || row.podChannels.some((c) => !AUTOMATION_CHANNELS.includes(c as AutomationChannel))) {
      throw new Error('POD channels must be SMS and/or E-mail')
    }
  }
  if (row.podAuto === true && Array.isArray(row.podChannels) && row.podChannels.length === 0) {
    throw new Error('Choose at least one channel for automatic POD requests')
  }
  if (row.quietHours != null) {
    const q = asRecord(row.quietHours)
    if (!q) throw new Error('Quiet hours must be an object')
    for (const key of ['start', 'end'] as const) {
      if (q[key] != null && !(typeof q[key] === 'string' && HHMM.test(q[key] as string))) {
        throw new Error(`Quiet hours ${key} must be a time like 21:00`)
      }
    }
    if (q.timezone != null && !isValidTimeZone(q.timezone)) throw new Error(`Unknown time zone: ${String(q.timezone)}`)
    if (q.channels != null && (!Array.isArray(q.channels) || q.channels.some((c) => !AUTOMATION_CHANNELS.includes(c as AutomationChannel)))) {
      throw new Error('Quiet hours channels must be SMS and/or E-mail')
    }
    const start = (q.start as string | undefined) ?? DEFAULT_AUTOMATION_POLICY.quietHours.start
    const end = (q.end as string | undefined) ?? DEFAULT_AUTOMATION_POLICY.quietHours.end
    if (q.enabled === true) {
      if (Array.isArray(q.channels) && q.channels.length === 0) throw new Error('Choose at least one channel for quiet hours')
      if (start === end) throw new Error('Quiet hours start and end must differ')
    }
  }
  if (row.templates != null) {
    const t = asRecord(row.templates)
    if (!t) throw new Error('Templates must be an object')
    for (const [key, value] of Object.entries(t)) {
      if (!(TEMPLATE_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown template: ${key}`)
      if (typeof value !== 'string') throw new Error(`Template ${key} must be text`)
      const problem = templateProblem(value, key as TemplateKey)
      if (problem) throw new Error(problem)
    }
  }
  return normalizeAutomationPatch(row)
}

export interface AutomationContext {
  settings?: { defaultCheckCallPlan?: unknown; trackingAutomation?: unknown } | null
  customer?: { checkCallPlan?: unknown; trackingAutomation?: unknown } | null
  load?: { checkCallPlan?: unknown } | null
  revDivision?: string | null
  revSubdivision?: string | null
}
export type PolicySource = 'DEFAULT' | 'GLOBAL' | 'DIVISION' | 'CUSTOMER'
export interface ResolvedAutomation {
  plan: CheckCallPlan
  planSource: CheckCallPlanSource
  policy: AutomationPolicy
  policySource: { [K in keyof AutomationPolicy]: PolicySource }
}

export function resolveAutomation(ctx: AutomationContext): ResolvedAutomation {
  const settings = normalizeTrackingAutomation(ctx.settings?.trackingAutomation)
  const codes = [ctx.revSubdivision, ctx.revDivision]
    .map((c) => String(c ?? '').trim())
    .filter((c, i, all) => c && all.indexOf(c) === i)
  const divisions = codes
    .map((c) => (Object.prototype.hasOwnProperty.call(settings.divisions, c) ? settings.divisions[c] : undefined))
    .filter((d): d is DivisionAutomation => Boolean(d))

  // Plan: whole-plan override, most specific first.
  let plan: CheckCallPlan = DEFAULT_CHECK_CALL_PLAN
  let planSource: CheckCallPlanSource = 'default'
  const candidates: [CheckCallPlanSource, CheckCallPlan | null][] = [
    ['load', normalizeCheckCallPlan(ctx.load?.checkCallPlan)],
    ['customer', normalizeCheckCallPlan(ctx.customer?.checkCallPlan)],
    ['division', divisions.map((d) => normalizeCheckCallPlan(d.plan)).find(Boolean) ?? null],
    ['org', normalizeCheckCallPlan(ctx.settings?.defaultCheckCallPlan)],
  ]
  for (const [source, candidate] of candidates) {
    if (candidate) { plan = candidate; planSource = source; break }
  }

  // Policy: layers lowest → highest precedence (subdivision beats its division).
  const layers: [PolicySource, AutomationPolicyPatch][] = [
    ['GLOBAL', settings.global],
    ...[...divisions].reverse().map((d): [PolicySource, AutomationPolicyPatch] => ['DIVISION', normalizeAutomationPatch(d.policy)]),
    ['CUSTOMER', normalizeAutomationPatch(ctx.customer?.trackingAutomation)],
  ]
  const policy: AutomationPolicy = {
    ...DEFAULT_AUTOMATION_POLICY,
    podChannels: [...DEFAULT_AUTOMATION_POLICY.podChannels],
    quietHours: { ...DEFAULT_AUTOMATION_POLICY.quietHours, channels: [...DEFAULT_AUTOMATION_POLICY.quietHours.channels] },
    templates: { ...DEFAULT_AUTOMATION_POLICY.templates },
  }
  const policySource: ResolvedAutomation['policySource'] = {
    checkCallsAuto: 'DEFAULT', podAuto: 'DEFAULT', podChannels: 'DEFAULT', quietHours: 'DEFAULT', templates: 'DEFAULT',
  }
  for (const [source, patch] of layers) {
    if (patch.checkCallsAuto !== undefined) { policy.checkCallsAuto = patch.checkCallsAuto; policySource.checkCallsAuto = source }
    if (patch.podAuto !== undefined) { policy.podAuto = patch.podAuto; policySource.podAuto = source }
    if (patch.podChannels !== undefined) { policy.podChannels = [...patch.podChannels]; policySource.podChannels = source }
    if (patch.quietHours !== undefined) { policy.quietHours = { ...patch.quietHours, channels: [...patch.quietHours.channels] }; policySource.quietHours = source }
    if (patch.templates) {
      for (const key of TEMPLATE_KEYS) {
        const v = patch.templates[key]
        if (v !== undefined) { policy.templates[key] = v; policySource.templates = source }
      }
    }
  }
  return { plan, planSource, policy, policySource }
}

// ── Quiet hours ──────────────────────────────────────────────────────────────

const clockFormats = new Map<string, Intl.DateTimeFormat>()

function localMinutes(timezone: string, ms: number): number {
  let fmt = clockFormats.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    clockFormats.set(timezone, fmt)
  }
  let hour = 0
  let minute = 0
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type === 'hour') hour = Number(part.value) % 24
    else if (part.type === 'minute') minute = Number(part.value)
  }
  return hour * 60 + minute
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function inWindow(q: QuietHours, ms: number): boolean {
  const start = toMinutes(q.start)
  const end = toMinutes(q.end)
  if (start === end) return false
  const now = localMinutes(q.timezone, ms)
  return start < end ? now >= start && now < end : now >= start || now < end
}

export function isQuietNow(q: QuietHours, channel: AutomationChannel, nowMs: number): boolean {
  if (!q.enabled || !q.channels.includes(channel)) return false
  return inWindow(q, nowMs)
}

/** When the current quiet window ends (minute precision); null when not currently quiet. */
export function quietEndsAtMs(q: QuietHours, nowMs: number): number | null {
  if (!q.enabled || !inWindow(q, nowMs)) return null
  const MIN = 60_000
  const limit = nowMs + 24 * 60 * MIN
  let t = Math.floor(nowMs / MIN) * MIN
  // Coarse 15-minute scan, then refine inside the step that crossed the boundary.
  let lastQuiet = t
  while (t < limit) {
    t += 15 * MIN
    if (!inWindow(q, t)) break
    lastQuiet = t
  }
  if (t >= limit && inWindow(q, t)) return limit
  for (let probe = lastQuiet + MIN; probe <= t; probe += MIN) {
    if (!inWindow(q, probe)) return probe
  }
  return t
}

// ── Templates ────────────────────────────────────────────────────────────────

const PLACEHOLDER_SET = new Set<string>(TEMPLATE_PLACEHOLDERS)

/** `{name}` substitution for the allow-listed placeholders; unknown names stay verbatim. */
export function renderTemplate(text: string, vars: Partial<Record<TemplatePlaceholder, string | null | undefined>>): string {
  return text.replace(/\{([^{}]*)\}/g, (whole, name: string) =>
    PLACEHOLDER_SET.has(name) ? String(vars[name as TemplatePlaceholder] ?? '') : whole)
}

/** null = ok. */
export function templateProblem(text: string, key: TemplateKey): string | null {
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDER_SET.has(match[1])) return `Unknown placeholder {${match[1]}}`
  }
  if (key.endsWith('Sms') && text.length > MAX_SMS_BODY) return `An SMS can be at most ${MAX_SMS_BODY} characters`
  if (text.length > MAX_TEMPLATE_CHARS) return `Text can be at most ${MAX_TEMPLATE_CHARS} characters`
  return null
}

export function sampleVars(): Record<TemplatePlaceholder, string> {
  return {
    proNumber: 'S-100234',
    loadNumber: 'L-5521',
    origin: 'Joliet, IL',
    destination: 'Dallas, TX',
    pickupDate: 'Mar 9',
    deliveryDate: 'Mar 11',
    customer: 'Acme Foods',
    carrier: 'Blue Line Transport',
    driverName: 'Sam',
    lastLocation: 'Springfield, MO',
    trackerName: 'Jordan Lee',
    trackerPhone: '(555) 010-2030',
    trackingUrl: 'https://example.com/t/abc123',
  }
}

/** The one definition of "a rate confirmation was sent": SENT, OPENED or SIGNED. */
export function isRateConSent(leg: { rateConStatus?: RateConStatus | string | null; rateConSentAt?: string | null }): boolean {
  const status = leg.rateConStatus
  if (status) return status === 'SENT' || status === 'OPENED' || status === 'SIGNED'
  return Boolean(leg.rateConSentAt)
}
