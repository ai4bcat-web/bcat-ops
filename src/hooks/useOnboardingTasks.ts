import { useState, useEffect, useCallback } from 'react'
import { listOnboardingTasks, updateOnboardingTask, setTaskStatus } from '@/lib/complianceClient'
import type { OnboardingTask, OnboardingTaskStatus, ComplianceEntityType } from '@/types'

const NO_TASKS: OnboardingTask[] = []

/** OnboardingTask checklist for a single driver or truck. */
export function useOnboardingTasks(entityType: ComplianceEntityType, entityId: string | null) {
  const key = `${entityType}|${entityId ?? ''}`
  const [loaded, setTasks] = useState<OnboardingTask[]>([])
  // Derived: true until a fetch for the CURRENT entity has settled.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!entityId) return Promise.resolve()
    return listOnboardingTasks(entityType, entityId)
      .then((next) => { setTasks(next) })
      .catch((err: unknown) => { console.error('[useOnboardingTasks] fetch error', err) })
      .finally(() => setLoadedKey(key))
  }, [entityType, entityId, key])

  useEffect(() => { void load() }, [load])

  const tasks = entityId ? loaded : NO_TASKS
  const loading = entityId != null && loadedKey !== key

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
