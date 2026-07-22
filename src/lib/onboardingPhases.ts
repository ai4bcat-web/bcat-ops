// Phase gating for the phased onboarding flow (Amazon driver template).
//
// Rules (from the spec):
//   - A phase is COMPLETE when every REQUIRED task in it is COMPLETE / WAIVED / NOT_APPLICABLE.
//     (A phase with no required tasks is vacuously complete.)
//   - currentPhase = the lowest-numbered phase that is not yet complete.
//   - The DRIVER portal exposes ONLY the current phase's tasks, and only where driverVisible.
//   - The OFFICE/staff UI shows ALL phases and may complete tasks out of order (not gated).
//
// Tasks carry their own `phase`, so phase membership doesn't depend on the template being
// loaded; the template only supplies phase titles and the total phase count.

import type { OnboardingTask } from '@/types'
import type { OnboardingTemplate } from './onboardingTemplates'

export const DONE_STATUSES: readonly OnboardingTask['status'][] = ['COMPLETE', 'WAIVED', 'NOT_APPLICABLE']

/** Days a current, incomplete phase can sit before it is flagged as stalled. */
export const STALLED_PHASE_THRESHOLD_DAYS = 7

export function isTaskDone(t: OnboardingTask): boolean {
  return DONE_STATUSES.includes(t.status)
}

/** A required task that isn't done yet — i.e. it blocks its phase. */
export function isBlocking(t: OnboardingTask): boolean {
  return t.required && !isTaskDone(t)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Distinct phase numbers present on these tasks, ascending. */
export function phaseNumbers(tasks: OnboardingTask[]): number[] {
  const set = new Set<number>()
  for (const t of tasks) if (typeof t.phase === 'number') set.add(t.phase)
  return [...set].sort((a, b) => a - b)
}

/** True when every required task in the phase is done (vacuously true if none required). */
export function phaseComplete(tasks: OnboardingTask[], phase: number): boolean {
  const required = tasks.filter((t) => t.phase === phase && t.required)
  return required.every(isTaskDone)
}

/** The lowest incomplete phase. If all phases are complete, returns the highest phase. */
export function currentPhaseNumber(tasks: OnboardingTask[]): number {
  const phases = phaseNumbers(tasks)
  if (phases.length === 0) return 1
  for (const p of phases) if (!phaseComplete(tasks, p)) return p
  return phases[phases.length - 1]
}

/** Tasks with a due date in the past that are not yet done. */
export function overdueTasks(tasks: OnboardingTask[], today = todayIso()): OnboardingTask[] {
  return tasks.filter((t) => t.dueDate && t.dueDate < today && !isTaskDone(t))
}

/**
 * A phase is "stalled" when it is the current (incomplete) phase and its most recent task
 * activity is older than `thresholdDays` — nothing has moved for too long.
 */
export function phaseStalled(
  tasks: OnboardingTask[],
  phase: number,
  thresholdDays = STALLED_PHASE_THRESHOLD_DAYS,
  now = new Date(),
): boolean {
  if (phase !== currentPhaseNumber(tasks)) return false
  if (phaseComplete(tasks, phase)) return false
  const inPhase = tasks.filter((t) => t.phase === phase)
  if (inPhase.length === 0) return false
  const lastActivity = inPhase.reduce((max, t) => {
    const ts = t.updatedAt || t.createdAt
    return ts > max ? ts : max
  }, '')
  if (!lastActivity) return false
  const ageDays = (now.getTime() - new Date(lastActivity).getTime()) / 86_400_000
  return ageDays > thresholdDays
}

export interface PhaseView {
  phase: number
  title: string
  driverTasks: OnboardingTask[]   // owner DRIVER (or legacy driver-actionable)
  officeTasks: OnboardingTask[]   // owner OFFICE (or legacy internal)
  tasks: OnboardingTask[]         // all tasks in the phase (both columns)
  requiredCount: number
  doneCount: number
  complete: boolean
  /** Locked for the driver portal (a later phase not yet reached). Always false for staff. */
  locked: boolean
  stalled: boolean
  overdue: OnboardingTask[]
}

function ownerColumn(t: OnboardingTask): 'DRIVER' | 'OFFICE' {
  if (t.owner) return t.owner
  // Legacy tasks (no owner): driver-actionable → driver column, else office.
  return t.driverActionable ? 'DRIVER' : 'OFFICE'
}

/**
 * Build per-phase views by merging a driver's tasks with the linked truck's tasks.
 * `forDriverPortal` filters to current-phase, driverVisible tasks and marks later phases locked.
 */
export function buildPhaseViews(opts: {
  template: OnboardingTemplate | null
  driverTasks: OnboardingTask[]
  truckTasks?: OnboardingTask[]
  forDriverPortal?: boolean
  thresholdDays?: number
}): PhaseView[] {
  const { template, driverTasks, truckTasks = [], forDriverPortal = false, thresholdDays } = opts
  const all = [...driverTasks, ...truckTasks]
  const current = currentPhaseNumber(all)

  // Phase list: template order when available, else whatever phases the tasks carry.
  const phaseDefs = template
    ? template.phases.map((p) => ({ phase: p.phase, title: p.title }))
    : phaseNumbers(all).map((p) => ({ phase: p, title: `Phase ${p}` }))

  const views: PhaseView[] = []
  for (const def of phaseDefs) {
    let inPhase = all.filter((t) => t.phase === def.phase)
    const complete = phaseComplete(all, def.phase)
    const locked = forDriverPortal && def.phase > current

    if (forDriverPortal) {
      // Drivers only ever see the current phase, and only driver-visible tasks.
      if (def.phase !== current) inPhase = []
      else inPhase = inPhase.filter((t) => t.driverVisible)
    }

    const required = inPhase.filter((t) => t.required)
    views.push({
      phase: def.phase,
      title: def.title,
      driverTasks: inPhase.filter((t) => ownerColumn(t) === 'DRIVER').sort((a, b) => a.sortOrder - b.sortOrder),
      officeTasks: inPhase.filter((t) => ownerColumn(t) === 'OFFICE').sort((a, b) => a.sortOrder - b.sortOrder),
      tasks: inPhase.sort((a, b) => a.sortOrder - b.sortOrder),
      requiredCount: required.length,
      doneCount: required.filter(isTaskDone).length,
      complete,
      locked,
      stalled: phaseStalled(all, def.phase, thresholdDays),
      overdue: overdueTasks(inPhase),
    })
  }
  return views
}
