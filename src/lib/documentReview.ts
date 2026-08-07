/**
 * Approving and rejecting a driver-uploaded document.
 *
 * Extracted from useReviewQueue so the driver file can review documents too (RW-149
 * stage 3) without a second copy of the rules. Neither action is a simple status flip:
 * each also settles the linked onboarding task, writes the compliance audit entry, and
 * — on rejection — tells the driver why. Two implementations would drift, and the one
 * that drifted would silently stop emailing or stop recording the audit trail.
 */
import {
  updateComplianceDocument, listOnboardingTasks, setTaskStatus, updateOnboardingTask,
  writeComplianceAudit, sendOnboardingEmail,
} from './complianceClient'
import type { ComplianceDocument, OnboardingTask } from '@/types'

/**
 * The checklist item a document satisfies — matched by explicit link first, then by
 * requirement key for documents uploaded outside the checklist flow.
 */
export async function findLinkedTask(doc: ComplianceDocument): Promise<OnboardingTask | undefined> {
  const tasks = await listOnboardingTasks(doc.entityType, doc.entityId)
  return tasks.find((t) => t.complianceDocumentId === doc.id)
    ?? tasks.find((t) => t.requirementKey === doc.documentType)
}

/**
 * Mark a driver's onboarding complete once every required item is settled, and tell
 * them. Only fires when there IS a checklist — a driver with no tasks must not be
 * declared complete on the strength of an empty list.
 */
export async function maybeCompleteOnboarding(
  driverId: string,
  userEmail: string | null | undefined,
  updateDriver: (id: string, patch: { onboardingStatus: 'COMPLETE' }) => Promise<unknown>,
): Promise<boolean> {
  const tasks = await listOnboardingTasks('DRIVER', driverId)
  const required = tasks.filter((t) => t.required && t.status !== 'NOT_APPLICABLE')
  const allDone = required.every((t) => t.status === 'COMPLETE' || t.status === 'WAIVED')
  if (required.length === 0 || !allDone) return false

  await updateDriver(driverId, { onboardingStatus: 'COMPLETE' })
  await writeComplianceAudit({
    entityType: 'DRIVER', entityId: driverId, action: 'onboarding_completed',
    user: userEmail ?? 'unknown', changes: { required: required.length },
  })
  void sendOnboardingEmail({ type: 'complete', driverId })
  return true
}

/** Accept a document: it becomes VALID and its checklist item is settled. */
export async function approveDocument(
  doc: ComplianceDocument,
  userEmail: string | null | undefined,
): Promise<ComplianceDocument> {
  const saved = await updateComplianceDocument(doc.id, {
    status: 'VALID',
    verifiedBy: userEmail ?? 'unknown',
    verifiedAt: new Date().toISOString(),
    rejectionReason: null,
  })
  const task = await findLinkedTask(doc)
  if (task) await setTaskStatus(task.id, 'COMPLETE', { completedBy: userEmail ?? undefined, complianceDocumentId: doc.id })
  await writeComplianceAudit({
    entityType: doc.entityType, entityId: doc.entityId, action: 'document_approved',
    user: userEmail ?? 'unknown', changes: { documentId: doc.id, documentType: doc.documentType },
  })
  return saved
}

/**
 * Send a document back. The item returns to the driver's queue and they are emailed the
 * reason — rejecting silently would leave them waiting on something they don't know is
 * wrong.
 */
export async function rejectDocument(
  doc: ComplianceDocument,
  reason: string,
  userEmail: string | null | undefined,
): Promise<ComplianceDocument> {
  const saved = await updateComplianceDocument(doc.id, { status: 'REJECTED', rejectionReason: reason })
  const task = await findLinkedTask(doc)
  if (task) await updateOnboardingTask(task.id, { status: 'AWAITING_DRIVER' })
  await writeComplianceAudit({
    entityType: doc.entityType, entityId: doc.entityId, action: 'document_rejected',
    user: userEmail ?? 'unknown', changes: { documentId: doc.id, reason },
  })
  if (doc.entityType === 'DRIVER') {
    void sendOnboardingEmail({ type: 'rejected', driverId: doc.entityId, itemLabel: doc.title, reason })
  }
  return saved
}
