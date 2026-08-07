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

/**
 * Group a driver's checklist for display.
 *
 * A templated driver (Amazon) is grouped by PHASE in order, because the phases gate each
 * other — seeing that someone is stuck in Phase 2 is more useful than "40% done".
 * Everyone else groups by category, which is how a flat checklist reads best.
 */
export function tasksByCategory(tasks: OnboardingTask[]): { category: string; tasks: OnboardingTask[] }[] {
  const phased = tasks.some((t) => t.phase != null)
  const sorted = [...tasks].sort((a, b) =>
    phased ? (a.phase ?? 99) - (b.phase ?? 99) || a.sortOrder - b.sortOrder : a.sortOrder - b.sortOrder,
  )

  const groups = new Map<string, OnboardingTask[]>()
  for (const t of sorted) {
    const key = phased ? `Phase ${t.phase ?? '—'}` : t.category
    const list = groups.get(key)
    if (list) list.push(t); else groups.set(key, [t])
  }
  return [...groups.entries()].map(([category, list]) => ({ category, tasks: list }))
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


// ── Driver status ───────────────────────────────────────────────────────────────

export type DriverStatus = 'ACTIVE' | 'ONBOARDING' | 'INACTIVE'

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  ACTIVE:     'Active',
  ONBOARDING: 'Onboarding',
  INACTIVE:   'Inactive',
}

/**
 * A driver's working status.
 *
 * Derived rather than stored, so it can't contradict the two things that already decide
 * it: the `active` flag (which you set) and how far the checklist has got (which the
 * work decides). A stored third value would let the badge disagree with the checklist.
 *
 * ONBOARDING is therefore not something you pick — a driver stays there until every box
 * is ticked, then becomes ACTIVE on their own. What you control is active vs inactive.
 * Inactive always wins: a deactivated driver isn't mid-onboarding, they're gone.
 */
/** Onboarding was explicitly kicked off and hasn't been finished or abandoned. */
const IN_ONBOARDING = new Set(['INVITED', 'IN_PROGRESS', 'PENDING_REVIEW'])

export function driverStatus(
  driver: { active?: boolean | null; onboardingStatus?: string | null },
  progress: { applicable: number; percent: number },
): DriverStatus {
  if (driver.active === false) return 'INACTIVE'
  if (driver.onboardingStatus === 'ARCHIVED') return 'INACTIVE'

  // ONBOARDING requires that someone actually STARTED it — the driver's own
  // onboardingStatus. Inferring it from "has a checklist" swept up every existing
  // driver who had tasks generated by the old compliance flow and labelled them
  // mid-hire. Established drivers read Active, which is what they are.
  if (!IN_ONBOARDING.has(driver.onboardingStatus ?? '')) return 'ACTIVE'

  // Started, but finished? Then they're active — the checklist decides the exit, so the
  // badge can't get stuck on Onboarding after the last box is ticked.
  const finished = progress.applicable > 0 && progress.percent === 100
  return finished ? 'ACTIVE' : 'ONBOARDING'
}

/** The percentage is only meaningful — and only shown — while onboarding. */
export const showsOnboardingPercent = (status: DriverStatus): boolean => status === 'ONBOARDING'


/**
 * Can this driver be switched between active and inactive right now?
 *
 * Reactivating someone mid-onboarding is allowed — they simply return to ONBOARDING
 * until their checklist is finished, which is the honest state rather than pretending
 * an unfinished driver is ready to run.
 */
export const canSetActive = (): boolean => true

/** What flipping the active flag would produce, so the UI can say so before you click. */
export function statusAfterToggle(
  driver: { active?: boolean | null; onboardingStatus?: string | null },
  progress: { applicable: number; percent: number },
): DriverStatus {
  return driverStatus({ ...driver, active: !(driver.active !== false) }, progress)
}


// ── Which onboarding flow a fleet gets ──────────────────────────────────────────

/**
 * The onboarding template for a fleet, or null for the flat checklist.
 *
 * Derived rather than chosen: Amazon runs the phased Relay flow, Local and Box Truck run
 * the flat list. The kickoff wizard used to ask, which meant it could be set to something
 * that contradicted the fleet — the same duplicate-entry problem as the classification
 * field.
 */
export const templateIdForFleet = (fleetGroup?: FleetGroup | null): string | null =>
  fleetGroup === 'AMAZON' ? 'amazon-driver-v1' : null


// ── One email per driver ────────────────────────────────────────────────────────

/**
 * A driver's email, wherever it was entered.
 *
 * It lives in two places: on the Driver record, and on their DriverPaySetting (where
 * settlements are emailed). Settlements were set up long before the driver file existed,
 * so most real addresses are on the pay setting — and the file was asking for it again.
 *
 * The driver record wins when both are set, since that's the one the file and the portal
 * invite maintain; the pay setting fills the gap for everyone onboarded through
 * settlements.
 */
export const resolveDriverEmail = (
  driver: { email?: string | null },
  paySettingEmail?: string | null,
): string => (driver.email?.trim() || paySettingEmail?.trim() || '')
