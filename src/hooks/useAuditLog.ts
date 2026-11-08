// Data-layer hook: read-only; no mutations exposed
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { listAuditLogsFor } from '@/lib/apiClient'
import type { AuditLogEntry } from '@/types'

export interface AuditEntity { entityType: string; entityId: string }

interface Fetched { key: string; at: string; rows: AuditLogEntry[] }

const keyOf = (entities: readonly AuditEntity[]) =>
  [...new Set(entities.map((e) => `${e.entityType}:${e.entityId}`))].sort().join('|')

/**
 * Without `entities`: this session's writes only — there is no server bulk read of the
 * audit table. With `entities`: those records' history, fetched once per distinct entity
 * set, plus any this-session entry for them written after the fetch started.
 */
export function useAuditLog(entities?: readonly AuditEntity[]): { entries: AuditLogEntry[]; loading: boolean } {
  const session = useAppStore((s) => s.auditLog)
  const key = entities && entities.length > 0 ? keyOf(entities) : ''
  const [fetched, setFetched] = useState<Fetched | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const at = new Date().toISOString()
    const wanted = key.split('|').map((k) => {
      const i = k.indexOf(':')
      return { entityType: k.slice(0, i), entityId: k.slice(i + 1) }
    })
    listAuditLogsFor(wanted)
      .then((rows) => { if (!cancelled) setFetched({ key, at, rows }) })
      .catch((err: unknown) => {
        console.warn('[useAuditLog] fetch failed', err)
        if (!cancelled) setFetched({ key, at, rows: [] })
      })
    return () => { cancelled = true }
  }, [key])

  const entries = useMemo(() => {
    if (!key) return session
    if (!fetched || fetched.key !== key) return []
    const wanted = new Set(key.split('|'))
    const seen = new Set(fetched.rows.map((r) => r.id))
    const fresh = session.filter(
      (e) => e.createdAt > fetched.at && !seen.has(e.id) && wanted.has(`${e.entityType}:${e.entityId}`),
    )
    return [...fresh, ...fetched.rows]
  }, [key, session, fetched])

  return { entries, loading: !!key && fetched?.key !== key }
}
