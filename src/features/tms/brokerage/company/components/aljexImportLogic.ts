/**
 * Pure rules behind the Aljex import stepper: layout detection from the header row, which steps a job
 * has reached, what blocks Plan and Apply, the Stalled test, progress. No React, no I/O, so the gates
 * the page enforces are the ones the tests pin.
 */
import { LAYOUT_V1, normalizeHeader } from '@/lib/aljex/layout'
import { findUnmapped } from '@/lib/aljex/profile'
import type { AljexProfile, DistinctValues, UnmappedValue } from '@/lib/aljex/profile'
import { ALJEX_STALLED_AFTER_MS } from '@/types/tms'
import type {
  AljexEntity, AljexImportJob, AljexImportPhase, AljexRehearsalGate, AljexStageSummary, DistinctValueCount,
} from '@/types/tms'

// ── file / layout ────────────────────────────────────────────────────────────

/** The first CSV record of `text` (quote-aware, BOM-tolerant). Never returns data rows. */
export function parseHeaderRecord(text: string): string[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const out: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1 } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { out.push(cell); return out }
    else cell += ch
  }
  out.push(cell)
  return out
}

export interface LayoutDetection {
  matches: boolean
  headerCount: number
  expectedCount: number
  layoutId: string
  /** 1-based columns whose header text differs from the layout's sentinel columns. */
  mismatchedColumns: number[]
}

/** Compare the header row with the sentinel columns of the one layout this importer knows. */
export function detectLayout(headers: readonly string[]): LayoutDetection {
  const { count, sentinels } = LAYOUT_V1.fingerprint
  const mismatchedColumns = sentinels
    .filter((s) => normalizeHeader(headers[s.index]) !== normalizeHeader(s.header))
    .map((s) => s.index + 1)
  return {
    matches: headers.length === count && mismatchedColumns.length === 0,
    headerCount: headers.length,
    expectedCount: count,
    layoutId: LAYOUT_V1.id,
    mismatchedColumns,
  }
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── job state ────────────────────────────────────────────────────────────────

type Tone = 'green' | 'red' | 'turquoise' | 'gray' | 'orange' | 'blue'

export function jobTone(job: AljexImportJob, now: number): Tone {
  if (isStalled(job, now)) return 'orange'
  switch (job.status) {
    case 'APPLIED': return 'green'
    case 'FAILED': return 'red'
    case 'RUNNING': case 'STAGING': case 'PLANNING': return 'blue'
    case 'READY': case 'PLANNED': case 'DRY_RUN': return 'turquoise'
    default: return 'gray'
  }
}

export const STEPS = ['File', 'Profile', 'Review', 'Plan', 'Apply', 'Reconcile'] as const
export type StepIndex = 0 | 1 | 2 | 3 | 4 | 5

/** Statuses a server worker is moving right now (the page polls while any of them holds). */
export const WORKING_STATUSES: ReadonlyArray<AljexImportJob['status']> = ['STAGING', 'PLANNING', 'RUNNING']

/** RUNNING whose worker has not checked in for 3 minutes. A missing heartbeat falls back to `startedAt`. */
export function isStalled(job: Pick<AljexImportJob, 'status' | 'heartbeatAt' | 'startedAt'>, now: number): boolean {
  if (job.status !== 'RUNNING') return false
  const beat = Date.parse(job.heartbeatAt ?? job.startedAt ?? '')
  return Number.isFinite(beat) && now - beat > ALJEX_STALLED_AFTER_MS
}

/** The furthest step this job may be opened at. Old pre-Phase-0 rows (DRY_RUN / APPLIED without a phase) stay at File. */
export function furthestStep(job: AljexImportJob | null): StepIndex {
  if (!job) return 0
  switch (job.status) {
    case 'STAGING': return 0
    case 'READY': return 3
    case 'PLANNING': return 3
    case 'PLANNED': return 4
    case 'RUNNING':
    case 'PAUSED': return 4
    case 'APPLIED': return 5
    case 'FAILED':
    case 'CANCELED': return job.phase && job.phase !== 'UPLOAD' && job.phase !== 'STAGE' ? 4 : 2
    default: return 0
  }
}

/** Where opening this job from the list should land. */
export function naturalStep(job: AljexImportJob): StepIndex {
  switch (job.status) {
    case 'READY': return 1
    case 'PLANNING':
    case 'PLANNED': return 3
    case 'RUNNING':
    case 'PAUSED': return 4
    case 'APPLIED': return 5
    default: return furthestStep(job)
  }
}

// ── profile / unmapped values ────────────────────────────────────────────────

const names = (list: DistinctValueCount[] | undefined): string[] => (list ?? []).map((d) => d.value)

/** The counts-less shape `findUnmapped` takes. */
export function distinctValuesOf(stage: AljexStageSummary | null | undefined): DistinctValues {
  const d = stage?.distinct ?? {}
  return {
    status: names(d.status),
    typeOfShipment: names(d.typeOfShipment),
    safetyRating: names(d.safetyRating),
    stopMarkers: names(d.stopMarkers),
    salesreps: names(d.salesreps),
    dispatchers: names(d.dispatchers),
  }
}

/** Every distinct value the CURRENT (possibly unsaved) profile has no answer for. */
export function unmappedFor(profile: AljexProfile, stage: AljexStageSummary | null | undefined): UnmappedValue[] {
  return findUnmapped(profile, distinctValuesOf(stage))
}

export const blockingOf = (list: UnmappedValue[]): UnmappedValue[] => list.filter((u) => u.blocking)

export function countOf(list: DistinctValueCount[] | undefined, value: string): number {
  return (list ?? []).find((d) => d.value === value)?.count ?? 0
}

// ── gates ────────────────────────────────────────────────────────────────────

export const REHEARSAL_TAG = /^[a-z0-9]{3,12}$/
export const LIVE_TAG = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/

export interface PlanGateInput {
  job: AljexImportJob | null
  /** Blocking unmapped values under the profile as currently edited. */
  blockingUnmapped: number
  /** True when the editor holds changes that are not saved yet. */
  profileDirty: boolean
}

/** Why Plan cannot start, or null. */
export function planBlockReason({ job, blockingUnmapped, profileDirty }: PlanGateInput): string | null {
  if (!job) return 'Upload a file first.'
  if (job.status !== 'READY' && job.status !== 'PLANNED') return `A job that is ${job.status.toLowerCase()} cannot be planned.`
  if (profileDirty) return 'Save the profile first.'
  if (blockingUnmapped > 0) return `${blockingUnmapped} value${blockingUnmapped === 1 ? '' : 's'} in the file ha${blockingUnmapped === 1 ? 's' : 've'} no mapping. Map them on the Profile step.`
  return null
}

export interface ApplyGateInput extends PlanGateInput {
  /** The profile version the PLAN ran under; a later save invalidates the plan. */
  plannedProfileVersion: number | null
  savedProfileVersion: number | null
  target: 'LIVE' | 'REHEARSAL'
  /** Rehearsal tag (`^[a-z0-9]{3,12}$`) or the typed live tag. */
  tag: string
  synthetic: boolean
  rehearsalGate: AljexRehearsalGate | null | undefined
}

/**
 * Why APPLY is disabled, or null. APPLY needs a PLANNED job with no unmapped blocking value, a plan
 * made under the saved profile, a rehearsal tag or — for LIVE — the typed tag, and for real data a
 * RECONCILED rehearsal of the same file and profile (the server decides; the UI shows its answer).
 */
export function applyBlockReason(input: ApplyGateInput): string | null {
  const { job, target, tag, synthetic, rehearsalGate } = input
  if (!job || job.status !== 'PLANNED') return 'Plan the import first.'
  if (input.profileDirty) return 'Save the profile and plan again.'
  if (input.blockingUnmapped > 0) return `${input.blockingUnmapped} unmapped value${input.blockingUnmapped === 1 ? '' : 's'} block the import.`
  if (input.plannedProfileVersion != null && input.savedProfileVersion != null && input.plannedProfileVersion !== input.savedProfileVersion) {
    return 'The profile changed after the plan. Plan again.'
  }
  if (target === 'REHEARSAL') {
    return REHEARSAL_TAG.test(tag.trim()) ? null : 'A rehearsal tag is 3–12 lowercase letters or digits.'
  }
  if (!LIVE_TAG.test(tag.trim())) return 'Type the live tag (3–40 letters, digits, - or _) to confirm a LIVE import.'
  if (!synthetic && rehearsalGate?.ok !== true) {
    return rehearsalGate?.reason ?? 'Real data needs a reconciled rehearsal of this same file and profile before it can go LIVE.'
  }
  return null
}

// ── progress ────────────────────────────────────────────────────────────────

const RUN_PHASES: AljexImportPhase[] = ['CUSTOMER', 'CARRIER', 'LOCATION', 'LOAD', 'AR_LEDGER', 'AP_LEDGER', 'FINALIZE', 'RECONCILE', 'DONE']

const ENTITIES: AljexEntity[] = ['LOAD', 'MEMO_DEBT', 'MEMO_CRED', 'CUSTOMER', 'CARRIER', 'LOCATION', 'INVOICE', 'AR_PAYMENT', 'BILL', 'AP_PAYMENT']

/** Rows of every entity that reached an outcome (staged = outcomes once finished). */
export function processedOf(job: AljexImportJob): { done: number; staged: number } {
  let done = 0
  let staged = 0
  for (const e of ENTITIES) {
    const c = job.entityCounts?.[e]
    if (!c) continue
    staged += c.staged
    done += c.created + c.matched + c.enriched + c.skipped + c.conflicts + c.errors
  }
  return { done, staged }
}

export interface ProgressView {
  phaseLabel: string
  phaseIndex: number
  phaseCount: number
  done: number
  staged: number
  percent: number | null
  rowsPerSecond: number | null
  etaSeconds: number | null
}

export function progressOf(job: AljexImportJob, now: number): ProgressView {
  const { done, staged } = processedOf(job)
  const started = Date.parse(job.startedAt ?? '')
  const seconds = Number.isFinite(started) ? Math.max(1, (now - started) / 1000) : null
  const rate = seconds != null && done > 0 ? done / seconds : null
  const phase = job.phase ?? job.cursor?.phase ?? null
  const phaseIndex = phase ? RUN_PHASES.indexOf(phase) : -1
  return {
    phaseLabel: phase ?? '—',
    phaseIndex: phaseIndex < 0 ? 0 : phaseIndex + 1,
    phaseCount: RUN_PHASES.length,
    done,
    staged,
    percent: staged > 0 ? Math.min(100, Math.round((done / staged) * 100)) : null,
    rowsPerSecond: rate,
    etaSeconds: rate != null && staged > done ? Math.round((staged - done) / rate) : null,
  }
}

/** Cents as a signed dollar string. */
export function dollars(cents: number | null | undefined): string {
  if (cents == null) return '—'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

/** "Aljex reported totals" box: dollars typed by a person -> cents, or null when blank/invalid. */
export function centsFromTyped(text: string): number | null {
  const t = text.trim().replace(/[$,\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null
  const negative = t.startsWith('-')
  const [whole, frac = ''] = t.replace('-', '').split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return negative ? -cents : cents
}

/** Sample-table cell. The server masks identifying values unless `unmask` was requested; money fields arrive as cents. */
export function sampleCell(key: string, value: string | number | null | undefined): string {
  if (value == null || value === '') return '—'
  return key.endsWith('Cents') && typeof value === 'number' ? dollars(value) : String(value)
}
