import { useState, useEffect, useCallback } from 'react'
import { listComplianceAlerts, updateComplianceAlert } from '@/lib/complianceClient'
import { useAuth } from '@/hooks/useAuth'
import type { ComplianceAlert } from '@/types'

const POLL_MS = 60_000

/** All compliance alerts (acknowledged + open). Polls so the dashboard stays fresh. */
export function useComplianceAlerts() {
  const { user } = useAuth()
  const [alerts, setAlerts] = useState<ComplianceAlert[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setAlerts(await listComplianceAlerts())
    } catch (err) {
      console.error('[useComplianceAlerts] fetch error', err)
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

  const acknowledge = useCallback(
    async (id: string) => {
      const updated = await updateComplianceAlert(id, {
        acknowledged: true,
        acknowledgedBy: user?.email ?? 'unknown',
        acknowledgedAt: new Date().toISOString(),
      })
      setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)))
      return updated
    },
    [user?.email],
  )

  const openAlerts = alerts.filter((a) => !a.acknowledged && !a.resolvedAt)

  return { alerts, openAlerts, loading, refresh: load, acknowledge }
}
