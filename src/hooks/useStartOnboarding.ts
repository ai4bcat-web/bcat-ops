import { useState, useCallback } from 'react'
import { generateChecklist, writeComplianceAudit } from '@/lib/complianceClient'
import type { DriverType, TruckOwnershipType } from '@/lib/complianceRequirements'
import { useAuth } from '@/hooks/useAuth'
import type { ComplianceEntityType, OnboardingTask } from '@/types'

/**
 * Bulk-create OnboardingTask records from the catalog for a driver or truck.
 * Idempotent (delegates to generateChecklist), so it can backfill new catalog items
 * or resume a partial generation.
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
      setIsStarting(true)
      try {
        const { created, total, tasks } = await generateChecklist(params)
        await writeComplianceAudit({
          entityType: params.entityType,
          entityId: params.entityId,
          action: 'onboarding_started',
          user: user?.email ?? 'unknown',
          changes: { classification: params.classification, created, total },
        })
        return tasks
      } finally {
        setIsStarting(false)
      }
    },
    [user?.email],
  )

  return { startOnboarding, isStarting }
}
