import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  listComplianceDocumentsByStatus,
  listApplicationsByStatus,
  listOnboardingTasks,
  updateDriverApplication,
  setTaskStatus,
  updateOnboardingTask,
  writeComplianceAudit,
  sendOnboardingEmail,
} from '@/lib/complianceClient'
import { useAuth } from '@/hooks/useAuth'
import { approveDocument as approveDoc, rejectDocument as rejectDoc } from '@/lib/documentReview'
import { driverPatchFromApplication } from '@/lib/applicationToDriver'
import { useAppStore } from '@/store/useAppStore'
import type { ComplianceDocument, DriverApplicationRecord } from '@/types'

const POLL_MS = 60_000

export interface ReviewQueueItem {
  kind: 'document' | 'application'
  id: string
  entityType: 'DRIVER' | 'TRUCK'
  entityId: string
  entityName: string
  label: string
  submittedAt: string
  document?: ComplianceDocument
  application?: DriverApplicationRecord
}

/**
 * Everything awaiting internal action: portal-uploaded ComplianceDocuments
 * (PENDING_REVIEW) and SUBMITTED DriverApplications. Powers /compliance/review
 * and the sidebar badge count.
 */
export function useReviewQueue() {
  const { user } = useAuth()
  const drivers = useAppStore((s) => s.drivers)
  const updateDriverInStore = useAppStore((s) => s.updateDriver)
  const [documents, setDocuments] = useState<ComplianceDocument[]>([])
  const [applications, setApplications] = useState<DriverApplicationRecord[]>([])
  const [loading, setLoading] = useState(true)

  const driverName = useCallback(
    (id: string) => drivers.find((d) => d.id === id)?.name ?? id,
    [drivers],
  )

  const load = useCallback(async () => {
    try {
      const [docs, apps] = await Promise.all([
        listComplianceDocumentsByStatus('PENDING_REVIEW'),
        listApplicationsByStatus('SUBMITTED'),
      ])
      setDocuments(docs)
      setApplications(apps)
    } catch (err) {
      console.error('[useReviewQueue] fetch error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const items: ReviewQueueItem[] = [
    ...applications.map((a) => ({
      kind: 'application' as const,
      id: a.id,
      entityType: 'DRIVER' as const,
      entityId: a.driverId,
      entityName: driverName(a.driverId),
      label: 'Employment application',
      submittedAt: a.signedAt ?? a.updatedAt,
      application: a,
    })),
    ...documents.map((d) => ({
      kind: 'document' as const,
      id: d.id,
      entityType: d.entityType,
      entityId: d.entityId,
      entityName: d.entityType === 'DRIVER' ? driverName(d.entityId) : d.entityId,
      label: d.title,
      submittedAt: d.createdAt,
      document: d,
    })),
  ].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))

  // ── Onboarding completion check ──
  const maybeCompleteOnboarding = useCallback(
    async (driverId: string) => {
      const tasks = await listOnboardingTasks('DRIVER', driverId)
      const required = tasks.filter((t) => t.required && t.status !== 'NOT_APPLICABLE')
      const done = required.every((t) => t.status === 'COMPLETE' || t.status === 'WAIVED')
      if (required.length > 0 && done) {
        await updateDriverInStore(driverId, { onboardingStatus: 'COMPLETE' })
        await writeComplianceAudit({
          entityType: 'DRIVER',
          entityId: driverId,
          action: 'onboarding_completed',
          user: user?.email ?? 'unknown',
          changes: { required: required.length },
        })
        void sendOnboardingEmail({ type: 'complete', driverId })
        toast.success(`🎉 ${driverName(driverId)} is fully onboarded`)
      }
    },
    [driverName, updateDriverInStore, user?.email],
  )

  /** Find the OnboardingTask linked to a document (by id or requirementKey). */
  // Shared with the driver file's review controls — see src/lib/documentReview.ts.
  const approveDocument = useCallback(
    async (doc: ComplianceDocument) => {
      await approveDoc(doc, user?.email)
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id))
      if (doc.entityType === 'DRIVER') await maybeCompleteOnboarding(doc.entityId)
    },
    [maybeCompleteOnboarding, user?.email],
  )

  const rejectDocument = useCallback(
    async (doc: ComplianceDocument, reason: string) => {
      await rejectDoc(doc, reason, user?.email)
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id))
    },
    [user?.email],
  )

  const approveApplication = useCallback(
    async (app: DriverApplicationRecord) => {
      await updateDriverApplication(app.id, {
        status: 'APPROVED',
        reviewedBy: user?.email ?? 'unknown',
        reviewedAt: new Date().toISOString(),
        rejectionReason: null,
      })
      const tasks = await listOnboardingTasks('DRIVER', app.driverId)
      const appTask = tasks.find((t) => t.requirementKey === 'employment_application')
      if (appTask) await setTaskStatus(appTask.id, 'COMPLETE', { completedBy: user?.email })

      // Fill the driver record from what they told us. A driver invited to apply starts
      // as a stub named from their email; without this the roster keeps showing that
      // stub and an empty phone while the real details sit inside the application.
      const driver = useAppStore.getState().drivers.find((d) => d.id === app.driverId)
      if (driver) {
        const patch = driverPatchFromApplication(app, driver)
        if (Object.keys(patch).length > 0) {
          try {
            await updateDriverInStore(app.driverId, patch)
          } catch (err) {
            // The application IS approved; a failed backfill shouldn't undo that.
            console.error('[review] could not fill the driver record from the application', err)
          }
        }
      }
      await writeComplianceAudit({
        entityType: 'DRIVER',
        entityId: app.driverId,
        action: 'document_approved',
        user: user?.email ?? 'unknown',
        changes: { applicationId: app.id },
      })
      setApplications((prev) => prev.filter((a) => a.id !== app.id))
      await maybeCompleteOnboarding(app.driverId)
    },
    [maybeCompleteOnboarding, user?.email],
  )

  const rejectApplication = useCallback(
    async (app: DriverApplicationRecord, reason: string) => {
      await updateDriverApplication(app.id, { status: 'REJECTED', rejectionReason: reason })
      const tasks = await listOnboardingTasks('DRIVER', app.driverId)
      const appTask = tasks.find((t) => t.requirementKey === 'employment_application')
      if (appTask) await updateOnboardingTask(appTask.id, { status: 'AWAITING_DRIVER' })
      await writeComplianceAudit({
        entityType: 'DRIVER',
        entityId: app.driverId,
        action: 'document_rejected',
        user: user?.email ?? 'unknown',
        changes: { applicationId: app.id, reason },
      })
      // Application decline is terminal — send the gracious "not a fit" email, NOT the
      // document-rejected "please fix and resubmit" one.
      void sendOnboardingEmail({ type: 'declined', driverId: app.driverId, itemLabel: 'Employment application', reason })
      setApplications((prev) => prev.filter((a) => a.id !== app.id))
    },
    [user?.email],
  )

  return {
    items,
    pendingCount: items.length,
    loading,
    refresh: load,
    approveDocument,
    rejectDocument,
    approveApplication,
    rejectApplication,
  }
}
