import { describe, it, expect } from 'vitest'
import {
  onboardingProgress, tasksByCategory, applicationFormFor, canSendApplication, APPLICATION_FORMS,
  driverStatus, showsOnboardingPercent,
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

  it('is Onboarding while a checklist exists and is unfinished', () => {
    expect(driverStatus({ active: true }, prog(10, 40))).toBe('ONBOARDING')
    expect(driverStatus({ active: true }, prog(1, 0))).toBe('ONBOARDING')
  })

  it('is Active once the checklist is finished', () => {
    expect(driverStatus({ active: true }, prog(10, 100))).toBe('ACTIVE')
    expect(driverStatus({ active: true, onboardingStatus: 'COMPLETE' }, prog(10, 90))).toBe('ACTIVE')
  })

  it('is Active for an established driver who never had a checklist', () => {
    // Not "0% onboarding" — they predate the process and aren't mid-hire.
    expect(driverStatus({ active: true }, prog(0, 0))).toBe('ACTIVE')
  })

  it('shows the percentage only while onboarding', () => {
    expect(showsOnboardingPercent('ONBOARDING')).toBe(true)
    expect(showsOnboardingPercent('ACTIVE')).toBe(false)
    expect(showsOnboardingPercent('INACTIVE')).toBe(false)
  })
})
