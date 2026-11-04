/**
 * Step AG — defaults and bounds. `resolveApInboxConfig` is the one place a stored (or posted)
 * config is clamped; the server floors (auto >= 0.85, review <= auto - 0.10) hold even if the
 * UI sends something lower.
 */
import type { ApInboxConfig } from './types'

export const AP_INBOX_MAILBOX = 'ai4bcat@gmail.com'
/** The Gmail token user id and the SIMULATED mailbox prefix (`spot-sim/ap-inbox/...`). */
export const AP_INBOX_USER_ID = 'ap-inbox'
/** Item id prefix: `apin:<gmailMessageId>`; `apin:sim:<id>` for the simulated inbox. */
export const AP_INBOX_ID_PREFIX = 'apin:'
/** S3 prefix for stored attachments / e-mail text (browser read already granted by storage). */
export const AP_INBOX_S3_PREFIX = 'intake-pdfs/ap-inbox/'
/** `updatedBy` stamped on a bill / payable the inbox wrote. */
export const AP_INBOX_ACTOR = 'ap-inbox'

export const AUTO_APPLY_MIN_FLOOR = 0.85
export const AUTO_APPLY_MIN_CEILING = 0.99
export const AMBIGUITY_MARGIN = 0.25
export const MEDIUM_CONFIDENCE_CAP = 0.84
export const LOW_CONFIDENCE_CAP = 0.49
export const MAX_RUNS_KEPT = 14
export const MAX_RETRY_KEPT = 50
export const MAX_BOUNDARY_IDS = 50
export const MAX_RETRIES = 3
export const RUN_STALE_MS = 6 * 60_000
export const MAX_LOOKBACK_MS = 7 * 86_400_000

export const DEFAULT_AP_INBOX_CONFIG: ApInboxConfig = {
  enabled: false,
  mode: 'GOOGLE',
  mailbox: AP_INBOX_MAILBOX,
  runHourChicago: 6,
  lookbackHours: 24,
  autoApply: true,
  autoApplyMinScore: 0.9,
  reviewMinScore: 0.5,
  maxMessagesPerRun: 200,
  maxModelCallsPerRun: 80,
  maxAutoAppliesPerRun: 50,
  dismissedRetentionDays: 30,
  resolvedRetentionDays: 180,
  ignoreSenders: [],
  version: 1,
}

function int(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100))
}

/** Stored or posted config → a fully valid one. Unknown keys are dropped; bad values fall back. */
export function resolveApInboxConfig(raw: unknown): ApInboxConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_AP_INBOX_CONFIG
  const auto = num(r.autoApplyMinScore, AUTO_APPLY_MIN_FLOOR, AUTO_APPLY_MIN_CEILING, d.autoApplyMinScore)
  const review = num(r.reviewMinScore, 0.3, Math.round((auto - 0.1) * 100) / 100, Math.min(d.reviewMinScore, auto - 0.1))
  const mailbox = typeof r.mailbox === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.mailbox.trim())
    ? r.mailbox.trim().toLowerCase()
    : d.mailbox
  const senders = Array.isArray(r.ignoreSenders)
    ? [...new Set(r.ignoreSenders.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 100)
    : []
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'SIMULATED' ? 'SIMULATED' : 'GOOGLE',
    mailbox,
    runHourChicago: int(r.runHourChicago, 0, 23, d.runHourChicago),
    lookbackHours: int(r.lookbackHours, 1, 168, d.lookbackHours),
    autoApply: r.autoApply === undefined ? d.autoApply : r.autoApply === true,
    autoApplyMinScore: auto,
    reviewMinScore: review,
    maxMessagesPerRun: int(r.maxMessagesPerRun, 1, 500, d.maxMessagesPerRun),
    maxModelCallsPerRun: int(r.maxModelCallsPerRun, 1, 300, d.maxModelCallsPerRun),
    maxAutoAppliesPerRun: int(r.maxAutoAppliesPerRun, 0, 200, d.maxAutoAppliesPerRun),
    dismissedRetentionDays: int(r.dismissedRetentionDays, 7, 365, d.dismissedRetentionDays),
    resolvedRetentionDays: int(r.resolvedRetentionDays, 7, 365, d.resolvedRetentionDays),
    ignoreSenders: senders,
    version: int(r.version, 1, Number.MAX_SAFE_INTEGER, 1),
  }
}
