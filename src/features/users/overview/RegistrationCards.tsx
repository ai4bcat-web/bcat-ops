import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DriverApplicationView } from '@/features/compliance/DriverApplicationView'
import {
  TmsApprovalCard,
  TmsBadge,
  TmsButton,
  TmsDialog,
  TmsDrawer,
  TmsEmptyState,
  TmsField,
  TmsTextarea,
} from '@/features/tms/kit'
import type { ReviewQueueItem } from '@/hooks/useReviewQueue'
import {
  refusalReasonText,
  type AwaitingVerification,
  type OpenSignupRefusal,
} from '@/lib/registrations'
import { errorMessage } from '@/lib/utils/errorMessage'
import type { DriverApplicationRecord } from '@/types'

export interface PendingStaffInvite {
  username: string
  email: string
}

export interface RegistrationCardsProps {
  applications: ReviewQueueItem[]
  refusals: OpenSignupRefusal[]
  awaiting: AwaitingVerification[]
  staffInvites: PendingStaffInvite[]
  onApprove: (app: DriverApplicationRecord) => Promise<void>
  onReject: (app: DriverApplicationRecord, reason: string) => Promise<void>
  onDismiss: (email: string) => Promise<void>
  onReinvite: (username: string) => Promise<void>
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : 'unknown date')

/** The four kinds of registration waiting on staff, as one scrolling row of cards. */
export function RegistrationCards({
  applications,
  refusals,
  awaiting,
  staffInvites,
  onApprove,
  onReject,
  onDismiss,
  onReinvite,
}: RegistrationCardsProps) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  const [viewing, setViewing] = useState<ReviewQueueItem | null>(null)
  const [rejecting, setRejecting] = useState<DriverApplicationRecord | null>(null)
  const [reason, setReason] = useState('')

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key)
    try {
      await action()
      if (success) toast.success(success)
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const total = applications.length + refusals.length + awaiting.length + staffInvites.length
  if (total === 0) {
    return <TmsEmptyState title="No registrations waiting." message={null} compact />
  }

  const submitReject = async () => {
    if (!rejecting || !reason.trim()) return
    const app = rejecting
    await run(`app:${app.id}`, () => onReject(app, reason.trim()), 'Application rejected')
    setRejecting(null)
    setReason('')
  }

  return (
    <>
      <div
        role="list"
        aria-label="New registrations"
        style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}
      >
        {applications.map((item) => {
          const app = item.application
          if (!app) return null
          return (
            <div key={`app:${item.id}`} role="listitem" style={{ flex: '0 0 300px' }}>
              <TmsApprovalCard
                title={item.entityName}
                subtitle={`Submitted ${day(item.submittedAt)}`}
                chip={<TmsBadge tone="blue">Driver application</TmsBadge>}
                busy={busy === `app:${item.id}`}
                actions={
                  <TmsButton size="sm" onClick={() => setViewing(item)}>
                    View
                  </TmsButton>
                }
                onApprove={() => void run(`app:${item.id}`, () => onApprove(app), 'Application approved')}
                onReject={() => {
                  setReason('')
                  setRejecting(app)
                }}
              />
            </div>
          )
        })}
        {refusals.map((r) => (
          <div key={`block:${r.email}`} role="listitem" style={{ flex: '0 0 300px' }}>
            <TmsApprovalCard
              title={r.email}
              subtitle={`Tried to sign up ${day(r.at)} · ${refusalReasonText(r.reason)}`}
              chip={<TmsBadge tone="red">Blocked sign-up</TmsBadge>}
              busy={busy === `block:${r.email}`}
              approveLabel="Open roster"
              rejectLabel="Dismiss"
              onApprove={() => navigate('/files')}
              onReject={() => void run(`block:${r.email}`, () => onDismiss(r.email), 'Dismissed')}
            />
          </div>
        ))}
        {awaiting.map((a) => (
          <div key={`await:${a.email}`} role="listitem" style={{ flex: '0 0 300px' }}>
            <TmsApprovalCard
              title={a.driverName}
              subtitle={a.email}
              chip={<TmsBadge tone="orange">Awaiting verification</TmsBadge>}
              meta={`Awaiting e-mail verification since ${day(a.since)}`}
            />
          </div>
        ))}
        {staffInvites.map((s) => (
          <div key={`invite:${s.username}`} role="listitem" style={{ flex: '0 0 300px' }}>
            <TmsApprovalCard
              title={s.email}
              subtitle="Invited — has not signed in yet"
              chip={<TmsBadge tone="gray">Staff invite</TmsBadge>}
              actions={
                <TmsButton
                  size="sm"
                  disabled={busy === `invite:${s.username}`}
                  onClick={() => void run(`invite:${s.username}`, () => onReinvite(s.username), '')}
                >
                  Resend invite
                </TmsButton>
              }
            />
          </div>
        ))}
      </div>

      <TmsDrawer
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
        title={viewing?.entityName ?? 'Driver application'}
        size="lg"
      >
        {viewing ? <DriverApplicationView driverId={viewing.entityId} /> : null}
      </TmsDrawer>

      <TmsDialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) setRejecting(null)
        }}
        title="Reject application"
        description="The applicant is told this is not a fit. Give the reason staff will see on the record."
        footer={
          <>
            <TmsButton onClick={() => setRejecting(null)}>Cancel</TmsButton>
            <TmsButton variant="reject" disabled={!reason.trim() || busy !== null} onClick={() => void submitReject()}>
              Reject
            </TmsButton>
          </>
        }
      >
        <TmsField label="Reason">
          <TmsTextarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </TmsField>
      </TmsDialog>
    </>
  )
}
