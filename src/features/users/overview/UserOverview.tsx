import { RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import { TmsAlert, TmsButton, TmsCard, TmsStatRow } from '@/features/tms/kit'
import { pendingRegistrationCounts, roleRows } from '@/lib/registrations'
import type { RoleKey, UserStatus } from '@/types/tms'
import { RegistrationCards } from './RegistrationCards'
import { RolesTable } from './RolesTable'
import { useRegistrations } from './useRegistrations'

export interface OverviewUser {
  username: string
  email: string
  role: RoleKey
  status: UserStatus
}

export interface UserOverviewProps {
  users: OverviewUser[]
  onReinvite: (username: string) => Promise<void>
}

/** Mounted above the cards on the Users tab (owner/ADMIN only, like the tab itself). */
export function UserOverview({ users, onReinvite }: UserOverviewProps) {
  const reg = useRegistrations()
  const roles = useMemo(() => roleRows(users), [users])
  const staffInvites = useMemo(() => users.filter((u) => u.status === 'PENDING'), [users])
  const counts = pendingRegistrationCounts({
    applications: reg.applications.length,
    blocked: reg.refusals.length,
    awaitingVerification: reg.awaiting.length,
    staffInvites: staffInvites.length,
  })

  return (
    <section aria-label="User overview" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <TmsStatRow
        aria-label="User overview totals"
        items={[
          { key: 'total', label: 'Total users', value: String(users.length + reg.activeDriverCount), sub: `${users.length} staff · ${reg.activeDriverCount} drivers` },
          {
            key: 'verified',
            label: 'Verified drivers',
            value: reg.verified === null ? null : String(reg.verified),
            sub: reg.verified === null ? 'Driver sign-in list unavailable' : `of ${reg.activeDriverCount} active`,
          },
          { key: 'active', label: 'Active staff', value: String(users.filter((u) => u.status === 'ACTIVE').length) },
          {
            key: 'pending',
            label: 'Pending registrations',
            value: String(counts.total),
            tone: counts.total > 0 ? 'warn' : undefined,
            sub: `${counts.applications} applications · ${counts.blocked} blocked · ${counts.awaitingVerification} unverified · ${counts.staffInvites} invites`,
          },
        ]}
      />

      {reg.error ? <TmsAlert tone="red" title="Could not load blocked sign-ups">{reg.error}</TmsAlert> : null}

      <TmsCard
        title="New registrations"
        actions={
          <TmsButton size="sm" onClick={() => void reg.refresh()} disabled={reg.loading}>
            <RefreshCw size={14} />Refresh
          </TmsButton>
        }
      >
        <RegistrationCards
          applications={reg.applications}
          refusals={reg.refusals}
          awaiting={reg.awaiting}
          staffInvites={staffInvites}
          onApprove={reg.approveApplication}
          onReject={reg.rejectApplication}
          onDismiss={reg.dismiss}
          onReinvite={onReinvite}
        />
      </TmsCard>

      <TmsCard title="Roles">
        <RolesTable rows={roles} />
      </TmsCard>
    </section>
  )
}
