import { useState, useEffect, useCallback } from 'react'
import {
  listOnboardingInvitesByDriver,
  createOnboardingInvite,
  updateOnboardingInvite,
  generateInviteToken,
  inviteExpiry,
  writeComplianceAudit,
} from '@/lib/complianceClient'
import { useAuth } from '@/hooks/useAuth'
import type { OnboardingInvite, DriverType } from '@/types'

/** OnboardingInvites for a driver, with resend / revoke / extend actions. */
export function useOnboardingInvites(driverId: string | null) {
  const { user } = useAuth()
  const [invites, setInvites] = useState<OnboardingInvite[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!driverId) {
      setInvites([])
      setLoading(false)
      return
    }
    try {
      const items = await listOnboardingInvitesByDriver(driverId)
      setInvites(items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    } catch (err) {
      console.error('[useOnboardingInvites] fetch error', err)
    } finally {
      setLoading(false)
    }
  }, [driverId])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  /** The active (non-revoked/expired) invite, if any. */
  const activeInvite = invites.find((i) => i.status !== 'REVOKED' && i.status !== 'EXPIRED') ?? null

  const createInvite = useCallback(
    async (email: string, driverType: DriverType) => {
      if (!driverId) throw new Error('No driver selected')
      const token = generateInviteToken()
      const invite = await createOnboardingInvite({
        driverId,
        email,
        driverType,
        token,
        status: 'SENT',
        expiresAt: inviteExpiry(),
        sentAt: new Date().toISOString(),
        requestCount: 0,
      })
      await writeComplianceAudit({
        entityType: 'DRIVER',
        entityId: driverId,
        action: 'invite_sent',
        user: user?.email ?? 'unknown',
        changes: { inviteId: invite.id, email },
      })
      setInvites((prev) => [invite, ...prev])
      return invite
    },
    [driverId, user?.email],
  )

  const revokeInvite = useCallback(
    async (id: string) => {
      const updated = await updateOnboardingInvite(id, { status: 'REVOKED' })
      setInvites((prev) => prev.map((i) => (i.id === id ? updated : i)))
      if (driverId) {
        await writeComplianceAudit({
          entityType: 'DRIVER',
          entityId: driverId,
          action: 'invite_revoked',
          user: user?.email ?? 'unknown',
          changes: { inviteId: id },
        })
      }
      return updated
    },
    [driverId, user?.email],
  )

  /** Resend: revoke the old token, issue a fresh one. */
  const resendInvite = useCallback(
    async (old: OnboardingInvite) => {
      await updateOnboardingInvite(old.id, { status: 'REVOKED' })
      const token = generateInviteToken()
      const invite = await createOnboardingInvite({
        driverId: old.driverId,
        email: old.email,
        driverType: old.driverType ?? null,
        token,
        status: 'SENT',
        expiresAt: inviteExpiry(),
        sentAt: new Date().toISOString(),
        requestCount: 0,
      })
      await writeComplianceAudit({
        entityType: 'DRIVER',
        entityId: old.driverId,
        action: 'invite_resent',
        user: user?.email ?? 'unknown',
        changes: { oldInviteId: old.id, newInviteId: invite.id },
      })
      await load()
      return invite
    },
    [load, user?.email],
  )

  const extendInvite = useCallback(
    async (id: string, days = 14) => {
      const updated = await updateOnboardingInvite(id, { expiresAt: inviteExpiry(days) })
      setInvites((prev) => prev.map((i) => (i.id === id ? updated : i)))
      if (driverId) {
        await writeComplianceAudit({
          entityType: 'DRIVER',
          entityId: driverId,
          action: 'invite_extended',
          user: user?.email ?? 'unknown',
          changes: { inviteId: id, days },
        })
      }
      return updated
    },
    [driverId, user?.email],
  )

  return { invites, activeInvite, loading, refresh: load, createInvite, revokeInvite, resendInvite, extendInvite }
}
