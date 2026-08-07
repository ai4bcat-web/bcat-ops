/**
 * Onboarding as seen from the driver file.
 *
 * The driver file is becoming the home for compliance (RW-149), so it needs to answer
 * three things about a driver: what they still owe, how far along they are, and which
 * application form applies to them.
 *
 * It reads the SAME OnboardingTask records the Compliance pages create — this is a
 * different view of one dataset, not a second checklist. Documents and action items are
 * both represented: a Clearinghouse query or a policy acknowledgement is an audit item
 * with no file attached, and dropping those would lose the proof they happened.
 */
import type { FleetGroup } from '@/types/equipment'
import type { OnboardingTask, OnboardingTaskStatus } from '@/types'

/** Statuses that mean the item needs nothing further. */
const SATISFIED: ReadonlySet<OnboardingTaskStatus> = new Set(['COMPLETE', 'WAIVED'])

/** Statuses that mean the item doesn't apply to this driver at all. */
const NOT_APPLICABLE: ReadonlySet<OnboardingTaskStatus> = new Set(['NOT_APPLICABLE'])

export interface OnboardingProgress {
  /** Items that count toward completion (excludes not-applicable). */
  applicable: number
  done:       number
  /** Waiting on the driver to act. */
  awaitingDriver: number
  /** Uploaded and waiting for someone to approve it. */
  awaitingReview:  number
  /** 0–100, rounded. 100 only when nothing is outstanding. */
  percent:    number
}

/**
 * How far through onboarding a driver is.
 *
 * Not-applicable items leave the denominator entirely rather than counting as done —
 * otherwise a driver could read as "80% complete" purely because most of the checklist
 * doesn't apply to them.
 */
export function onboardingProgress(tasks: OnboardingTask[]): OnboardingProgress {
  let applicable = 0, done = 0, awaitingDriver = 0, awaitingReview = 0

  for (const t of tasks) {
    if (NOT_APPLICABLE.has(t.status)) continue
    applicable++
    if (SATISFIED.has(t.status)) done++
    else if (t.status === 'AWAITING_DRIVER') awaitingDriver++
    else if (t.status === 'PENDING_REVIEW') awaitingReview++
  }

  return {
    applicable,
    done,
    awaitingDriver,
    awaitingReview,
    // A driver with no checklist yet is 0%, not 100% — nothing has been verified.
    percent: applicable === 0 ? 0 : Math.round((done / applicable) * 100),
  }
}

/** Group a driver's checklist by category, preserving each category's sort order. */
export function tasksByCategory(tasks: OnboardingTask[]): { category: string; tasks: OnboardingTask[] }[] {
  const byCategory = new Map<string, OnboardingTask[]>()
  for (const t of [...tasks].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const list = byCategory.get(t.category)
    if (list) list.push(t); else byCategory.set(t.category, [t])
  }
  return [...byCategory.entries()].map(([category, list]) => ({ category, tasks: list }))
}

// ── Application forms ───────────────────────────────────────────────────────────

export interface ApplicationForm {
  /** Stored on the invite so the portal knows which form to render. */
  key:   string
  label: string
  /** What the driver is told they're filling in. */
  blurb: string
}

/**
 * One application per fleet. All three currently render the DOT application (49 CFR
 * 391.21) — the fleet-specific questions are built out per form, and keying them
 * separately from the start means adding those never needs a data migration.
 */
export const APPLICATION_FORMS: Record<FleetGroup, ApplicationForm> = {
  LOCAL: {
    key: 'application_local',
    label: 'Local (Ivan) driver application',
    blurb: 'DOT employment application — 3 years of employment history, 10 if you hold a CDL.',
  },
  BOX_TRUCK: {
    key: 'application_box_truck',
    label: 'Box truck driver application',
    blurb: 'DOT employment application for box-truck work.',
  },
  AMAZON: {
    key: 'application_amazon',
    label: 'Amazon driver application',
    blurb: 'DOT employment application for Amazon Relay work, including lease details.',
  },
}

export const applicationFormFor = (fleetGroup?: FleetGroup | null): ApplicationForm | null =>
  fleetGroup ? APPLICATION_FORMS[fleetGroup] : null

/**
 * Whether a driver can be invited to apply. A fleet is required because it decides
 * which form they get and which documents their file will ask for — inviting without
 * one produces a driver nobody can classify later.
 */
export function canSendApplication(driver: { email?: string | null; fleetGroup?: FleetGroup | null }): {
  ok: boolean
  reason?: string
} {
  if (!driver.fleetGroup) return { ok: false, reason: 'Set the driver’s fleet first — it decides which application they get.' }
  if (!driver.email?.trim()) return { ok: false, reason: 'Add an email address to send the application to.' }
  return { ok: true }
}
