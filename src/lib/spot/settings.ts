/**
 * Step AB §2.5 — defaults and validators for the per-rep (`GmailConnection.settings`) and
 * org (`SpotSettings`) switches. Pure; relative imports only (Lambdas bundle by path).
 *
 * Read-only mailbox (Ryne, 2026-11-04): there is no auto-send, send or draft switch at any level.
 * The legacy `autoSend*` / `allowAutoSend` columns stay on the tables (additive-only schema) but
 * nothing reads or writes them.
 */
import type { GmailRepSettings, SpotSettingsRecord } from '../../types/tms'
import { stripControl } from './text'

export const DEFAULT_REP_SETTINGS: GmailRepSettings = {
  watchLabel: null,
  lookbackDays: 2,
  signature: '',
  replyTemplateId: 'DEFAULT',
  notifyNew: true,
}

export interface ResolvedSpotSettings {
  enabled: boolean
  retentionDays: number
  dismissedRetentionDays: number
  modelCallsPerRepPerDay: number
  maxMessagesPerRepPerRun: number
}

export const DEFAULT_SPOT_SETTINGS: ResolvedSpotSettings = {
  enabled: true,
  retentionDays: 90,
  dismissedRetentionDays: 14,
  modelCallsPerRepPerDay: 100,
  maxMessagesPerRepPerRun: 50,
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const SPOT_NUMBER_BOUNDS: Record<
  Exclude<keyof ResolvedSpotSettings, 'enabled'>,
  [number, number]
> = {
  retentionDays: [1, 365],
  dismissedRetentionDays: [1, 90],
  modelCallsPerRepPerDay: [0, 2000],
  maxMessagesPerRepPerRun: [1, 200],
}

function intIn(value: unknown, lo: number, hi: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) return null
  return n
}

export function resolveSpotSettings(row?: Partial<SpotSettingsRecord> | null): ResolvedSpotSettings {
  const out: ResolvedSpotSettings = { ...DEFAULT_SPOT_SETTINGS }
  if (!row) return out
  if (typeof row.enabled === 'boolean') out.enabled = row.enabled
  for (const key of Object.keys(SPOT_NUMBER_BOUNDS) as (keyof typeof SPOT_NUMBER_BOUNDS)[]) {
    const [lo, hi] = SPOT_NUMBER_BOUNDS[key]
    const n = intIn(row[key], lo, hi)
    if (n != null) out[key] = n
  }
  return out
}

export function validateSpotSettings(patch: unknown): Result<Partial<ResolvedSpotSettings>> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Settings must be an object.' }
  const src = patch as Record<string, unknown>
  const value: Partial<ResolvedSpotSettings> = {}
  for (const key of ['enabled'] as const) {
    if (src[key] === undefined) continue
    if (typeof src[key] !== 'boolean') return { ok: false, error: `${key} must be true or false.` }
    value[key] = src[key] as boolean
  }
  for (const key of Object.keys(SPOT_NUMBER_BOUNDS) as (keyof typeof SPOT_NUMBER_BOUNDS)[]) {
    if (src[key] === undefined) continue
    const [lo, hi] = SPOT_NUMBER_BOUNDS[key]
    const n = intIn(src[key], lo, hi)
    if (n == null) return { ok: false, error: `${key} must be a whole number from ${lo} to ${hi}.` }
    value[key] = n
  }
  return { ok: true, value }
}

const SIGNATURE_MAX = 400
const LABEL_MAX = 100

function cleanText(value: string, max: number): string {
  return stripControl(value, '', true).slice(0, max).trim()
}

export function resolveRepSettings(raw: unknown): GmailRepSettings {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: GmailRepSettings = { ...DEFAULT_REP_SETTINGS }
  if (typeof src.watchLabel === 'string' && src.watchLabel.trim()) out.watchLabel = cleanText(src.watchLabel, LABEL_MAX) || null
  const days = intIn(src.lookbackDays, 1, 7)
  if (days != null) out.lookbackDays = days
  if (typeof src.signature === 'string') out.signature = cleanText(src.signature, SIGNATURE_MAX)
  if (typeof src.replyTemplateId === 'string' && /^[A-Z0-9_]{1,40}$/.test(src.replyTemplateId)) out.replyTemplateId = src.replyTemplateId
  if (typeof src.notifyNew === 'boolean') out.notifyNew = src.notifyNew
  return out
}

export function validateRepSettings(patch: unknown): Result<Partial<GmailRepSettings>> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Settings must be an object.' }
  const src = patch as Record<string, unknown>
  const value: Partial<GmailRepSettings> = {}
  for (const key of ['notifyNew'] as const) {
    if (src[key] === undefined) continue
    if (typeof src[key] !== 'boolean') return { ok: false, error: `${key} must be true or false.` }
    value[key] = src[key] as boolean
  }
  if (src.watchLabel !== undefined) {
    if (src.watchLabel !== null && typeof src.watchLabel !== 'string') return { ok: false, error: 'watchLabel must be text or empty.' }
    const label = typeof src.watchLabel === 'string' ? cleanText(src.watchLabel, LABEL_MAX) : ''
    value.watchLabel = label || null
  }
  if (src.lookbackDays !== undefined) {
    const n = intIn(src.lookbackDays, 1, 7)
    if (n == null) return { ok: false, error: 'lookbackDays must be a whole number from 1 to 7.' }
    value.lookbackDays = n
  }
  if (src.signature !== undefined) {
    if (typeof src.signature !== 'string') return { ok: false, error: 'signature must be text.' }
    if (src.signature.length > SIGNATURE_MAX) return { ok: false, error: `Signature is limited to ${SIGNATURE_MAX} characters.` }
    value.signature = cleanText(src.signature, SIGNATURE_MAX)
  }
  if (src.replyTemplateId !== undefined) {
    if (typeof src.replyTemplateId !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(src.replyTemplateId)) {
      return { ok: false, error: 'replyTemplateId is not valid.' }
    }
    value.replyTemplateId = src.replyTemplateId
  }
  return { ok: true, value }
}
