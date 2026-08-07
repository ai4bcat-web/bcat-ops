import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listOnboardingTasks, setTaskStatus, generateChecklist, createOnboardingInvite,
  generateInviteToken, inviteExpiry, buildPortalUrl, writeComplianceAudit,
} from '@/lib/complianceClient'
import { onboardingProgress, tasksByCategory, applicationFormFor } from '@/lib/driverOnboarding'
import { classificationForFleet } from '@/lib/fileHub'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import type { Driver, OnboardingTask } from '@/types'

/**
 * A driver's onboarding, as the driver file sees it.
 *
 * Reads the same OnboardingTask records the Compliance pages create — one dataset, two
 * views — so starting onboarding here and finishing it there (or vice versa) works.
 */
export function useDriverOnboarding(driver: Driver | null) {
  const { user } = useAuth()
  const updateDriverRecord = useAppStore((st) => st.updateDriver)
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const driverId = driver?.id ?? null

  const load = useCallback(async () => {
    if (!driverId) { setTasks([]); setLoading(false); return }
    setLoading(true)
    try {
      setTasks(await listOnboardingTasks('DRIVER', driverId))
    } catch (err) {
      console.error('[useDriverOnboarding] load', err)
    } finally {
      setLoading(false)
    }
  }, [driverId])

  useEffect(() => { void load() }, [load])

  const progress = useMemo(() => onboardingProgress(tasks), [tasks])
  const grouped = useMemo(() => tasksByCategory(tasks), [tasks])

  /**
   * Generate the checklist for this driver. Idempotent — generateChecklist skips items
   * that already exist, so this also backfills newly added catalog requirements onto a
   * driver who started earlier.
   */
  const start = useCallback(async () => {
    if (!driver) return
    setBusy(true)
    try {
      await generateChecklist({
        entityType: 'DRIVER',
        entityId: driver.id,
        // Derived from the fleet, the same rule the driver file uses — so the checklist
        // and the file can't ask for different paperwork for the same driver.
        classification: classificationForFleet(driver.fleetGroup),
      })
      // Record that onboarding was STARTED. Status is derived from this, so without it
      // the driver would keep reading Active with a checklist nobody is tracking.
      await updateDriverRecord(driver.id, { onboardingStatus: 'IN_PROGRESS' })
      await load()
    } finally { setBusy(false) }
  }, [driver, load, updateDriverRecord])

  /**
   * Invite the driver to apply. The invite carries the fleet so the portal can render
   * that fleet's application form.
   */
  const sendApplication = useCallback(async (): Promise<string | null> => {
    if (!driver?.email || !driver.fleetGroup) return null
    setBusy(true)
    try {
      const token = generateInviteToken()
      await createOnboardingInvite({
        driverId: driver.id,
        email: driver.email,
        driverType: driver.driverType ?? null,
        token,
        status: 'SENT',
        expiresAt: inviteExpiry(),
        sentAt: new Date().toISOString(),
      })
      await writeComplianceAudit({
        entityType: 'DRIVER', entityId: driver.id, action: 'onboarding_started',
        user: user?.email ?? 'unknown',
        changes: { fleetGroup: driver.fleetGroup, form: applicationFormFor(driver.fleetGroup)?.key },
      })
      await updateDriverRecord(driver.id, { onboardingStatus: 'INVITED' })
      return buildPortalUrl(token)
    } finally { setBusy(false) }
  }, [driver, user, updateDriverRecord])

  /** Tick or untick an action item (the non-upload parts of the checklist). */
  const toggleTask = useCallback(async (task: OnboardingTask) => {
    const next = task.status === 'COMPLETE' ? 'PENDING' : 'COMPLETE'
    const updated = await setTaskStatus(task.id, next, { completedBy: user?.email ?? 'unknown' })
    setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)))
  }, [user])

  return { tasks, grouped, progress, loading, busy, start, sendApplication, toggleTask, refresh: load }
}
