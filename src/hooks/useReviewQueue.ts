import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  listComplianceDocumentsByStatus,
  listApplicationsByStatus,
  listOnboardingTasks,
  updateComplianceDocument,
  updateDriverApplication,
  setTaskStatus,
  updateOnboardingTask,
  writeComplianceAudit,
  sendOnboardingEmail,
} from '@/lib/complianceClient'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import type { ComplianceDocument, DriverApplicationRecord, OnboardingTask } from '@/types'

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
  const findLinkedTask = useCallback(
    async (doc: ComplianceDocument): Promise<OnboardingTask | undefined> => {
      const tasks = await listOnboardingTasks(doc.entityType, doc.entityId)
      return (
        tasks.find((t) => t.complianceDocumentId === doc.id) ??
        tasks.find((t) => t.requirementKey === doc.documentType)
      )
    },
    [],
  )

  const approveDocument = useCallback(
    async (doc: ComplianceDocument) => {
      await updateComplianceDocument(doc.id, {
        status: 'VALID',
        verifiedBy: user?.email ?? 'unknown',
        verifiedAt: new Date().toISOString(),
        rejectionReason: null,
      })
      const task = await findLinkedTask(doc)
      if (task) await setTaskStatus(task.id, 'COMPLETE', { completedBy: user?.email, complianceDocumentId: doc.id })
      await writeComplianceAudit({
        entityType: doc.entityType,
        entityId: doc.entityId,
        action: 'document_approved',
        user: user?.email ?? 'unknown',
        changes: { documentId: doc.id, documentType: doc.documentType },
      })
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id))
      if (doc.entityType === 'DRIVER') await maybeCompleteOnboarding(doc.entityId)
    },
    [findLinkedTask, maybeCompleteOnboarding, user?.email],
  )

  const rejectDocument = useCallback(
    async (doc: ComplianceDocument, reason: string) => {
      await updateComplianceDocument(doc.id, { status: 'REJECTED', rejectionReason: reason })
      const task = await findLinkedTask(doc)
      if (task) await updateOnboardingTask(task.id, { status: 'AWAITING_DRIVER' })
      await writeComplianceAudit({
        entityType: doc.entityType,
        entityId: doc.entityId,
        action: 'document_rejected',
        user: user?.email ?? 'unknown',
        changes: { documentId: doc.id, reason },
      })
      if (doc.entityType === 'DRIVER') void sendOnboardingEmail({ type: 'rejected', driverId: doc.entityId, itemLabel: doc.title, reason })
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id))
    },
    [findLinkedTask, user?.email],
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
      void sendOnboardingEmail({ type: 'rejected', driverId: app.driverId, itemLabel: 'Employment application', reason })
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
