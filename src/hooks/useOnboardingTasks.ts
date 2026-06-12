import { useState, useEffect, useCallback } from 'react'
import { listOnboardingTasks, updateOnboardingTask, setTaskStatus } from '@/lib/complianceClient'
import type { OnboardingTask, OnboardingTaskStatus, ComplianceEntityType } from '@/types'

/** OnboardingTask checklist for a single driver or truck. */
export function useOnboardingTasks(entityType: ComplianceEntityType, entityId: string | null) {
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!entityId) {
      setTasks([])
      setLoading(false)
      return
    }
    try {
      setTasks(await listOnboardingTasks(entityType, entityId))
    } catch (err) {
      console.error('[useOnboardingTasks] fetch error', err)
    } finally {
      setLoading(false)
    }
  }, [entityType, entityId])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const patchTask = useCallback(
    async (id: string, patch: Partial<Omit<OnboardingTask, 'id' | 'createdAt' | 'updatedAt'>>) => {
      const updated = await updateOnboardingTask(id, patch)
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)))
      return updated
    },
    [],
  )

  const changeStatus = useCallback(
    async (
      id: string,
      status: OnboardingTaskStatus,
      opts?: { completedBy?: string; complianceDocumentId?: string },
    ) => {
      const updated = await setTaskStatus(id, status, opts)
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)))
      return updated
    },
    [],
  )

  // Progress over REQUIRED items only (COMPLETE or WAIVED count as done).
  const requiredTasks = tasks.filter((t) => t.required && t.status !== 'NOT_APPLICABLE')
  const doneCount = requiredTasks.filter((t) => t.status === 'COMPLETE' || t.status === 'WAIVED').length
  const requiredCount = requiredTasks.length
  const allRequiredDone = requiredCount > 0 && doneCount === requiredCount

  return {
    tasks,
    loading,
    refresh: load,
    patchTask,
    changeStatus,
    doneCount,
    requiredCount,
    allRequiredDone,
  }
}
