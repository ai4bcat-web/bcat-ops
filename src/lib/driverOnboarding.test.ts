import { describe, it, expect } from 'vitest'
import {
  onboardingProgress, tasksByCategory, applicationFormFor, canSendApplication, APPLICATION_FORMS,
  driverStatus, showsOnboardingPercent, templateIdForFleet,
} from './driverOnboarding'
import type { OnboardingTask, OnboardingTaskStatus } from '@/types'

const task = (status: OnboardingTaskStatus, over: Partial<OnboardingTask> = {}): OnboardingTask => ({
  id: Math.random().toString(36).slice(2), entityType: 'DRIVER', entityId: 'd1',
  requirementKey: 'k', label: 'Item', category: 'General', required: true,
  requiresDocument: true, requiresExpiration: false, driverVisible: true, driverActionable: true,
  status, sortOrder: 0, createdAt: '', updatedAt: '', ...over,
})

describe('onboarding progress', () => {
  it('is 0% for a driver with no checklist — nothing has been verified', () => {
    const p = onboardingProgress([])
    expect(p.percent).toBe(0)
    expect(p.applicable).toBe(0)
  })

  it('counts complete and waived as done', () => {
    const p = onboardingProgress([task('COMPLETE'), task('WAIVED'), task('PENDING')])
    expect(p.done).toBe(2)
    expect(p.applicable).toBe(3)
    expect(p.percent).toBe(67)
  })

  it('drops not-applicable items from the denominator, not into "done"', () => {
    // Otherwise a driver reads as nearly complete purely because little applies to them.
    const p = onboardingProgress([task('COMPLETE'), task('NOT_APPLICABLE'), task('NOT_APPLICABLE')])
    expect(p.applicable).toBe(1)
    expect(p.done).toBe(1)
    expect(p.percent).toBe(100)
  })

  it('separates what the driver owes from what we owe them', () => {
    const p = onboardingProgress([
      task('AWAITING_DRIVER'), task('AWAITING_DRIVER'), task('PENDING_REVIEW'), task('COMPLETE'),
    ])
    expect(p.awaitingDriver).toBe(2)
    expect(p.awaitingReview).toBe(1)
    expect(p.percent).toBe(25)
  })

  it('only reports 100% when nothing is outstanding', () => {
    expect(onboardingProgress([task('COMPLETE'), task('PENDING_REVIEW')]).percent).toBe(50)
    expect(onboardingProgress([task('COMPLETE'), task('COMPLETE')]).percent).toBe(100)
  })
})

describe('tasksByCategory', () => {
  it('groups and orders by sortOrder within each category', () => {
    const groups = tasksByCategory([
      task('PENDING', { category: 'B', label: 'b1', sortOrder: 2 }),
      task('PENDING', { category: 'A', label: 'a2', sortOrder: 1 }),
      task('PENDING', { category: 'A', label: 'a1', sortOrder: 0 }),
    ])
    expect(groups.map((g) => g.category)).toEqual(['A', 'B'])
    expect(groups[0].tasks.map((t) => t.label)).toEqual(['a1', 'a2'])
  })

  it('handles an empty checklist', () => {
    expect(tasksByCategory([])).toEqual([])
  })
})

describe('application forms', () => {
  it('has a distinct form for each of the three fleets', () => {
    const keys = Object.values(APPLICATION_FORMS).map((f) => f.key)
    expect(new Set(keys).size).toBe(3)
    expect(applicationFormFor('LOCAL')?.key).toBe('application_local')
    expect(applicationFormFor('BOX_TRUCK')?.key).toBe('application_box_truck')
    expect(applicationFormFor('AMAZON')?.key).toBe('application_amazon')
  })

  it('has none for an unclassified driver', () => {
    expect(applicationFormFor(null)).toBeNull()
    expect(applicationFormFor(undefined)).toBeNull()
  })
})

describe('canSendApplication', () => {
  it('requires a fleet, because it decides the form and the required documents', () => {
    const r = canSendApplication({ email: 'a@b.com', fleetGroup: null })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/fleet/i)
  })

  it('requires an email to send to', () => {
    const r = canSendApplication({ email: '', fleetGroup: 'LOCAL' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/email/i)
  })

  it('treats whitespace as no email', () => {
    expect(canSendApplication({ email: '   ', fleetGroup: 'LOCAL' }).ok).toBe(false)
  })

  it('allows it once both are set', () => {
    expect(canSendApplication({ email: 'a@b.com', fleetGroup: 'AMAZON' }).ok).toBe(true)
  })
})

describe('driver status', () => {
  const prog = (applicable: number, percent: number) => ({ applicable, percent })

  it('is Inactive when the driver is deactivated, whatever onboarding says', () => {
    expect(driverStatus({ active: false }, prog(10, 50))).toBe('INACTIVE')
    expect(driverStatus({ active: false }, prog(0, 0))).toBe('INACTIVE')
  })

  it('treats an archived candidate as inactive', () => {
    expect(driverStatus({ active: true, onboardingStatus: 'ARCHIVED' }, prog(5, 20))).toBe('INACTIVE')
  })

  it('is Onboarding only once onboarding was explicitly started', () => {
    expect(driverStatus({ active: true, onboardingStatus: 'IN_PROGRESS' }, prog(10, 40))).toBe('ONBOARDING')
    expect(driverStatus({ active: true, onboardingStatus: 'INVITED' }, prog(1, 0))).toBe('ONBOARDING')
  })

  it('leaves EXISTING drivers active even when they already have a checklist', () => {
    // The old compliance flow generated tasks for established drivers. Inferring
    // "onboarding" from the presence of a checklist labelled all of them mid-hire.
    expect(driverStatus({ active: true }, prog(10, 40))).toBe('ACTIVE')
    expect(driverStatus({ active: true, onboardingStatus: null }, prog(20, 5))).toBe('ACTIVE')
  })

  it('moves to Active once every box is ticked', () => {
    expect(driverStatus({ active: true, onboardingStatus: 'IN_PROGRESS' }, prog(10, 100))).toBe('ACTIVE')
    expect(driverStatus({ active: true, onboardingStatus: 'COMPLETE' }, prog(10, 90))).toBe('ACTIVE')
  })

  it('is Active for an established driver who never had a checklist', () => {
    expect(driverStatus({ active: true }, prog(0, 0))).toBe('ACTIVE')
  })

  it('does not get stuck on Onboarding with an empty checklist', () => {
    // Started but nothing generated yet — still onboarding, not silently "done".
    expect(driverStatus({ active: true, onboardingStatus: 'IN_PROGRESS' }, prog(0, 0))).toBe('ONBOARDING')
  })

  it('shows the percentage only while onboarding', () => {
    expect(showsOnboardingPercent('ONBOARDING')).toBe(true)
    expect(showsOnboardingPercent('ACTIVE')).toBe(false)
    expect(showsOnboardingPercent('INACTIVE')).toBe(false)
  })
})

describe('checklist grouping', () => {
  it('groups a templated driver by phase, in order', () => {
    const groups = tasksByCategory([
      task('PENDING', { phase: 2, category: 'Payroll', label: 'b', sortOrder: 0 }),
      task('PENDING', { phase: 1, category: 'Application', label: 'a', sortOrder: 1 }),
      task('PENDING', { phase: 1, category: 'License', label: 'a0', sortOrder: 0 }),
    ])
    expect(groups.map((g) => g.category)).toEqual(['Phase 1', 'Phase 2'])
    // Phases gate each other, so order within a phase still matters.
    expect(groups[0].tasks.map((t) => t.label)).toEqual(['a0', 'a'])
  })

  it('falls back to categories when the driver has no template', () => {
    const groups = tasksByCategory([
      task('PENDING', { category: 'Payroll', sortOrder: 1 }),
      task('PENDING', { category: 'Application', sortOrder: 0 }),
    ])
    expect(groups.map((g) => g.category)).toEqual(['Application', 'Payroll'])
  })
})

describe('onboarding flow by fleet', () => {
  it('gives Amazon the phased Relay template and everyone else the flat list', () => {
    expect(templateIdForFleet('AMAZON')).toBe('amazon-driver-v1')
    expect(templateIdForFleet('LOCAL')).toBeNull()
    expect(templateIdForFleet('BOX_TRUCK')).toBeNull()
    expect(templateIdForFleet(null)).toBeNull()
  })
})
