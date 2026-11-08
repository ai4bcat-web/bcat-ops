import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { useAppStore } from '@/store/useAppStore'
import {
  awaitingVerification,
  openSignupRefusals,
  verifiedDriverCount,
  type AwaitingVerification,
  type DriverPoolLogin,
  type OpenSignupRefusal,
  type SignupAuditEntry,
} from '@/lib/registrations'
import {
  type DriverPoolResult,
  SignupAuditNeedsScanError,
  dismissDriverSignup,
  listDriverPoolUsers,
  listDriverSignupAudit,
  listDriverSignupAuditScan,
} from '@/lib/registrationsClient'
import { errorMessage } from '@/lib/utils/errorMessage'

interface RegistrationsFetch {
  audit: PromiseSettledResult<SignupAuditEntry[]>
  poolResult: PromiseSettledResult<DriverPoolResult>
}

/** `needs-scan`: no AuditLog index is deployed, so refusals load only on the user's click. */
export type SignupAuditState = 'loading' | 'loaded' | 'needs-scan'

/**
 * Everything the Users overview reads that the Users page does not already hold. Loaded
 * once on mount and on `refresh` — deliberately not polled (S4 §3.2). The driver-pool read
 * fails soft: an older deploy has no `listDriverPool`, and the overview then shows "—".
 */
export function useRegistrations() {
  const { user } = useAuth()
  const drivers = useAppStore((s) => s.drivers)
  const queue = useReviewQueue()
  const { refresh: refreshQueue } = queue
  const [refusals, setRefusals] = useState<OpenSignupRefusal[]>([])
  const [pool, setPool] = useState<DriverPoolLogin[] | null>(null)
  const [poolNote, setPoolNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [signup, setSignup] = useState<SignupAuditState>('loading')
  const [scanning, setScanning] = useState(false)

  const fetchAll = useCallback(async (): Promise<RegistrationsFetch> => {
    const [audit, poolResult] = await Promise.allSettled([listDriverSignupAudit(), listDriverPoolUsers()])
    return { audit, poolResult }
  }, [])

  const apply = useCallback(
    ({ audit, poolResult }: RegistrationsFetch) => {
      if (audit.status === 'fulfilled') {
        setRefusals(openSignupRefusals(audit.value))
        setSignup('loaded')
        setError(null)
      } else if (audit.reason instanceof SignupAuditNeedsScanError) {
        setSignup((prev) => (prev === 'loaded' ? prev : 'needs-scan'))
        setError(null)
      } else {
        setError(errorMessage(audit.reason))
      }
      if (poolResult.status === 'fulfilled') {
        setPool(poolResult.value.users)
        setPoolNote(poolResult.value.reason ?? null)
      } else {
        setPool(null)
        setPoolNote(errorMessage(poolResult.reason))
      }
      setLoading(false)
    },
    [],
  )

  useEffect(() => {
    let live = true
    void fetchAll().then((result) => {
      if (live) apply(result)
    })
    return () => {
      live = false
    }
  }, [fetchAll, apply])

  const refresh = useCallback(async () => {
    setLoading(true)
    const [result] = await Promise.all([fetchAll(), refreshQueue()])
    apply(result)
  }, [fetchAll, apply, refreshQueue])

  const dismiss = useCallback(
    async (email: string) => {
      await dismissDriverSignup(email, user?.email ?? 'unknown')
      setRefusals((prev) => prev.filter((r) => r.email !== email.toLowerCase().trim()))
    },
    [user?.email],
  )

  const loadRefusals = useCallback(async () => {
    setScanning(true)
    try {
      setRefusals(openSignupRefusals(await listDriverSignupAuditScan()))
      setSignup('loaded')
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setScanning(false)
    }
  }, [])

  const awaiting: AwaitingVerification[] = useMemo(
    () => (pool ? awaitingVerification(pool, drivers) : []),
    [pool, drivers],
  )
  const verified = useMemo(
    () =>
      pool && !poolNote
        ? verifiedDriverCount(drivers.filter((d) => d.active).map((d) => d.email), pool)
        : null,
    [pool, poolNote, drivers],
  )

  return {
    applications: queue.items.filter((i) => i.kind === 'application'),
    approveApplication: queue.approveApplication,
    rejectApplication: queue.rejectApplication,
    refusals,
    signup,
    scanning,
    loadRefusals,
    awaiting,
    verified,
    poolNote,
    activeDriverCount: drivers.filter((d) => d.active).length,
    loading: loading || queue.loading,
    error,
    refresh,
    dismiss,
  }
}
