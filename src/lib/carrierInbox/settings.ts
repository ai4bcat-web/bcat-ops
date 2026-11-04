/**
 * Step AL §2.2 — `SpotSettings` row `carrier-sales`, `carrierInbox` attribute: defaults,
 * lenient reader and the strict validator behind `CS_SAVE_SETTINGS`. The floors live here so
 * a UI bug can never lower them. Nothing secret is stored: the voice secret is a hash that
 * only `withVoiceSecret` (the rotate action) writes.
 */
import type { CarrierInboxConfig, CarrierInboxMailbox, CarrierInboxVoiceConfig } from './types'

export const DEFAULT_BOARD_SENDER_DOMAINS = ['dat.com', 'truckstop.com', '123loadboard.com'] as const
export const MAX_MAILBOXES = 5
export const MAX_ADDRESSES_PER_MAILBOX = 10
export const MAX_IGNORE_SENDERS = 100

export const DEFAULT_CARRIER_INBOX_CONFIG: CarrierInboxConfig = {
  enabled: false,
  mailboxes: [],
  lookbackHours: 24,
  maxMessagesPerRun: 100,
  modelCallsPerDay: 300,
  autoFileMinScore: 0.85,
  suggestMinScore: 0.5,
  unmatchedRetentionDays: 30,
  ignoreSenders: [],
  boardSenderDomains: [...DEFAULT_BOARD_SENDER_DOMAINS],
  voice: { enabled: false, secretHash: null, rotatedAt: null, maxTranscriptChars: 20_000 },
  version: 1,
}

export class CarrierInboxConfigError extends Error {
  readonly code: 'INVALID' | 'CONFLICT'
  constructor(code: 'INVALID' | 'CONFLICT', message: string) {
    super(message)
    this.name = 'CarrierInboxConfigError'
    this.code = code
  }
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/
const MAILBOX_ID = /^[a-z0-9][a-z0-9-]{0,15}$/
const SENDER_ENTRY = /^@?[^\s@<>]+(?:@[^\s@<>]+)?$/
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function parseRaw(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean) : []

const uniq = (list: string[]): string[] => [...new Set(list)]

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

function mailboxOf(v: unknown): CarrierInboxMailbox | null {
  const m = parseRaw(v)
  const id = typeof m.id === 'string' ? m.id.trim().toLowerCase() : ''
  const account = typeof m.account === 'string' ? m.account.trim().toLowerCase() : ''
  if (!MAILBOX_ID.test(id)) return null
  return {
    id,
    label: (typeof m.label === 'string' ? m.label.trim() : '').slice(0, 60) || account || id,
    account,
    addresses: uniq(strings(m.addresses)).slice(0, MAX_ADDRESSES_PER_MAILBOX),
    gmailLabel: typeof m.gmailLabel === 'string' && m.gmailLabel.trim() ? m.gmailLabel.trim().slice(0, 100) : null,
    mode: m.mode === 'SIMULATED' ? 'SIMULATED' : 'GOOGLE',
    paused: m.paused === true,
  }
}

/** Fills every default and clamps every number into its range. Never throws; unknown input = defaults. */
export function resolveCarrierInboxConfig(raw: unknown): CarrierInboxConfig {
  const c = parseRaw(raw)
  const d = DEFAULT_CARRIER_INBOX_CONFIG
  const v = parseRaw(c.voice)
  const auto = clamp(num(c.autoFileMinScore, d.autoFileMinScore), 0.8, 0.99)
  const mailboxes: CarrierInboxMailbox[] = []
  for (const entry of Array.isArray(c.mailboxes) ? c.mailboxes : []) {
    const mb = mailboxOf(entry)
    if (mb && !mailboxes.some((x) => x.id === mb.id) && mailboxes.length < MAX_MAILBOXES) mailboxes.push(mb)
  }
  const board = Array.isArray(c.boardSenderDomains) ? uniq(strings(c.boardSenderDomains)) : [...DEFAULT_BOARD_SENDER_DOMAINS]
  return {
    enabled: c.enabled === true,
    mailboxes,
    lookbackHours: Math.round(clamp(num(c.lookbackHours, d.lookbackHours), 1, 168)),
    maxMessagesPerRun: Math.round(clamp(num(c.maxMessagesPerRun, d.maxMessagesPerRun), 1, 300)),
    modelCallsPerDay: Math.round(clamp(num(c.modelCallsPerDay, d.modelCallsPerDay), 0, 2000)),
    autoFileMinScore: auto,
    suggestMinScore: clamp(num(c.suggestMinScore, d.suggestMinScore), 0.3, Math.round((auto - 0.1) * 100) / 100),
    unmatchedRetentionDays: Math.round(clamp(num(c.unmatchedRetentionDays, d.unmatchedRetentionDays), 7, 90)),
    ignoreSenders: uniq(strings(c.ignoreSenders)).slice(0, MAX_IGNORE_SENDERS),
    boardSenderDomains: board,
    voice: {
      enabled: v.enabled === true,
      secretHash: typeof v.secretHash === 'string' && v.secretHash ? v.secretHash : null,
      rotatedAt: typeof v.rotatedAt === 'string' && v.rotatedAt ? v.rotatedAt : null,
      maxTranscriptChars: Math.round(clamp(num(v.maxTranscriptChars, d.voice.maxTranscriptChars), 1000, 50_000)),
    },
    version: Math.max(1, Math.round(num(c.version, 1))),
  }
}

function bad(message: string): never {
  throw new CarrierInboxConfigError('INVALID', message)
}

function inRange(name: string, value: unknown, lo: number, hi: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) bad(`${name} must be a number`)
  if (value < lo || value > hi) bad(`${name} must be between ${lo} and ${hi}`)
  return value
}

/**
 * Strict validation of a client-supplied config. Throws `CarrierInboxConfigError`
 * (`INVALID` for a rule, `CONFLICT` when `raw.version` is not `prev.version`). The result carries
 * `version = prev.version + 1`; `voice.secretHash/rotatedAt` always come from `prev`, an existing
 * mailbox keeps the `mode` it has and a new one is `GOOGLE` (simulated mailboxes are created by the
 * dev-only `CS_CONNECT_SIMULATED`, never by a settings save).
 */
export function validateCarrierInboxConfig(raw: unknown, prev: CarrierInboxConfig | null): CarrierInboxConfig {
  const c = parseRaw(raw)
  if (prev && typeof c.version === 'number' && c.version !== prev.version) {
    throw new CarrierInboxConfigError('CONFLICT', 'The Carrier Sales settings changed since you opened them; reload and try again.')
  }
  const base = prev ?? DEFAULT_CARRIER_INBOX_CONFIG

  const rawBoxes = Array.isArray(c.mailboxes) ? c.mailboxes : []
  if (rawBoxes.length > MAX_MAILBOXES) bad(`At most ${MAX_MAILBOXES} mailboxes`)
  const mailboxes: CarrierInboxMailbox[] = []
  for (const entry of rawBoxes) {
    const m = parseRaw(entry)
    const id = typeof m.id === 'string' ? m.id.trim().toLowerCase() : ''
    if (!MAILBOX_ID.test(id)) bad('Mailbox id must be 1-16 lower-case letters, digits or dashes')
    if (mailboxes.some((x) => x.id === id)) bad(`Mailbox id ${id} is used twice`)
    const account = typeof m.account === 'string' ? m.account.trim().toLowerCase() : ''
    if (!EMAIL.test(account)) bad(`Mailbox ${id}: the Google account must be an e-mail address`)
    const addresses = uniq(strings(m.addresses))
    if (addresses.length > MAX_ADDRESSES_PER_MAILBOX) bad(`Mailbox ${id}: at most ${MAX_ADDRESSES_PER_MAILBOX} addresses`)
    for (const a of addresses) if (!EMAIL.test(a)) bad(`Mailbox ${id}: "${a}" is not an e-mail address`)
    const gmailLabel = typeof m.gmailLabel === 'string' && m.gmailLabel.trim() ? m.gmailLabel.trim().slice(0, 100) : null
    const existing = prev?.mailboxes.find((x) => x.id === id)
    mailboxes.push({
      id,
      label: (typeof m.label === 'string' ? m.label.trim() : '').slice(0, 60) || account,
      account,
      addresses,
      gmailLabel,
      mode: existing?.mode ?? 'GOOGLE',
      paused: m.paused === true,
    })
  }

  const enabled = c.enabled === true
  if (enabled && mailboxes.length === 0) bad('Add a mailbox before turning Carrier Sales listening on')

  const lookbackHours = inRange('Look-back hours', c.lookbackHours ?? base.lookbackHours, 1, 168)
  const maxMessagesPerRun = inRange('Messages per run', c.maxMessagesPerRun ?? base.maxMessagesPerRun, 1, 300)
  const modelCallsPerDay = inRange('Model calls per day', c.modelCallsPerDay ?? base.modelCallsPerDay, 0, 2000)
  const autoFileMinScore = inRange('Auto-file threshold', c.autoFileMinScore ?? base.autoFileMinScore, 0.8, 0.99, false)
  const suggestMinScore = inRange('Suggestion threshold', c.suggestMinScore ?? base.suggestMinScore, 0.3, 0.99, false)
  if (suggestMinScore > Math.round((autoFileMinScore - 0.1) * 100) / 100 + 1e-9) {
    bad('The suggestion threshold must be at least 0.10 below the auto-file threshold')
  }
  const unmatchedRetentionDays = inRange('Unmatched retention days', c.unmatchedRetentionDays ?? base.unmatchedRetentionDays, 7, 90)

  const ignoreSenders = uniq(strings(c.ignoreSenders ?? base.ignoreSenders))
  if (ignoreSenders.length > MAX_IGNORE_SENDERS) bad(`At most ${MAX_IGNORE_SENDERS} ignored senders`)
  for (const s of ignoreSenders) if (s.length > 254 || !SENDER_ENTRY.test(s)) bad(`"${s}" is not an address or domain`)
  const boardSenderDomains = uniq(strings(c.boardSenderDomains ?? base.boardSenderDomains))
  if (boardSenderDomains.length > 20) bad('At most 20 load-board domains')
  for (const dom of boardSenderDomains) if (!DOMAIN.test(dom)) bad(`"${dom}" is not a domain`)

  const v = parseRaw(c.voice)
  const voice: CarrierInboxVoiceConfig = {
    enabled: v.enabled === true,
    secretHash: base.voice.secretHash,
    rotatedAt: base.voice.rotatedAt,
    maxTranscriptChars: inRange('Transcript characters', v.maxTranscriptChars ?? base.voice.maxTranscriptChars, 1000, 50_000),
  }

  return {
    enabled,
    mailboxes,
    lookbackHours,
    maxMessagesPerRun,
    modelCallsPerDay,
    autoFileMinScore,
    suggestMinScore,
    unmatchedRetentionDays,
    ignoreSenders,
    boardSenderDomains,
    voice,
    version: (prev?.version ?? 0) + 1,
  }
}

/** The only writer of `voice.secretHash` (the rotate action). Bumps `version`. */
export function withVoiceSecret(cfg: CarrierInboxConfig, secretHash: string, nowIso: string): CarrierInboxConfig {
  return { ...cfg, voice: { ...cfg.voice, secretHash, rotatedAt: nowIso }, version: cfg.version + 1 }
}
