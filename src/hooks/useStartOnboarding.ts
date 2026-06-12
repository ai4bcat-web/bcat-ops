import { useState, useCallback } from 'react'
import {
  listOnboardingTasks,
  createOnboardingTask,
  writeComplianceAudit,
} from '@/lib/complianceClient'
import {
  getDriverRequirements,
  getTruckRequirements,
  type ComplianceRequirement,
  type DriverType,
  type TruckOwnershipType,
} from '@/lib/complianceRequirements'
import { useAuth } from '@/hooks/useAuth'
import type { ComplianceEntityType, OnboardingTask, OnboardingTaskStatus } from '@/types'

/**
 * Initial status for a generated task:
 *  - optional (not required) items start NOT_APPLICABLE (e.g. hazmat, dashcam) — staff/driver opt in
 *  - driver-actionable required items wait on the driver (AWAITING_DRIVER)
 *  - everything else is internal work (PENDING)
 */
function initialStatus(req: ComplianceRequirement, entityType: ComplianceEntityType): OnboardingTaskStatus {
  if (!req.required) return 'NOT_APPLICABLE'
  if (entityType === 'DRIVER' && req.driverActionable) return 'AWAITING_DRIVER'
  return 'PENDING'
}

/**
 * Bulk-create OnboardingTask records from the catalog for a driver or truck.
 * Idempotent: existing tasks (by requirementKey) are skipped so it can be re-run
 * to backfill new catalog items or resume a partial generation.
 */
export function useStartOnboarding() {
  const { user } = useAuth()
  const [isStarting, setIsStarting] = useState(false)

  const startOnboarding = useCallback(
    async (params: {
      entityType: ComplianceEntityType
      entityId: string
      classification: DriverType | TruckOwnershipType
    }): Promise<OnboardingTask[]> => {
      const { entityType, entityId, classification } = params
      setIsStarting(true)
      try {
        const requirements =
          entityType === 'DRIVER'
            ? getDriverRequirements(classification as DriverType)
            : getTruckRequirements(classification as TruckOwnershipType)

        const existing = await listOnboardingTasks(entityType, entityId)
        const existingKeys = new Set(existing.map((t) => t.requirementKey))

        const created: OnboardingTask[] = []
        for (let i = 0; i < requirements.length; i++) {
          const req = requirements[i]
          if (existingKeys.has(req.key)) continue
          const task = await createOnboardingTask({
            entityType,
            entityId,
            requirementKey: req.key,
            label: req.label,
            category: req.category,
            required: req.required,
            requiresDocument: req.requiresDocument,
            requiresExpiration: req.requiresExpiration,
            driverVisible: entityType === 'DRIVER' ? req.driverVisible : false,
            driverActionable: entityType === 'DRIVER' ? req.driverActionable : false,
            status: initialStatus(req, entityType),
            sortOrder: i,
          })
          created.push(task)
        }

        await writeComplianceAudit({
          entityType,
          entityId,
          action: 'onboarding_started',
          user: user?.email ?? 'unknown',
          changes: { classification, created: created.length, total: requirements.length },
        })

        return [...existing, ...created].sort((a, b) => a.sortOrder - b.sortOrder)
      } finally {
        setIsStarting(false)
      }
    },
    [user?.email],
  )

  return { startOnboarding, isStarting }
}
