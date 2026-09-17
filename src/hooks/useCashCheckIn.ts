import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  DEFAULT_CASH_SETTINGS,
  validateCashCheckIn,
  type CashCheckIn,
  type CashCheckInInput,
  type CashSettingsValues,
} from '@/lib/cashCheckIn'
import {
  createCashCheckIn,
  createCashSettings,
  deleteCashCheckIn as deleteCashCheckInClient,
  getCashSettings,
  isSchemaMissingError,
  listCashCheckIns,
  subscribeCashCheckIns,
  subscribeCashSettings,
  updateCashCheckIn,
  updateCashSettings,
} from '@/lib/cashCheckInClient'

export interface UseCashCheckIn {
  checkins: CashCheckIn[]
  settings: CashSettingsValues
  canWrite: boolean
  loading: boolean
  saving: boolean
  settingsSaving: boolean
  error: string | null
  /** True when the backend tables are not in the deployed schema yet. */
  backendMissing?: boolean
  updateSettings: (next: CashSettingsValues) => void
  saveCheckIn: (input: CashCheckInInput, id?: string) => Promise<void>
  deleteCheckIn: (id: string) => Promise<void>
  importCheckIns: (rows: CashCheckInInput[]) => Promise<{ imported: number; skipped: number }>
}

function sortCheckins(checkins: CashCheckIn[]): CashCheckIn[] {
  return [...checkins].sort((a, b) => (a.date < b.date ? 1 : -1))
}

function isConflictError(err: unknown): boolean {
  const s = typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /ConditionalCheckFailedException|already exists|Duplicate|Conflict/i.test(s)
}

/** Amplify rejects with the raw `{ data, errors }` envelope, not an Error — read its message. */
function errorMessage(err: unknown): string {
  const gql = (err as { errors?: { message?: string }[] } | null)?.errors?.[0]?.message
  if (gql) return gql
  return err instanceof Error ? err.message : String(err)
}

/**
 * Hook for the Weekly Cash Check-in feature.
 *
 * - Loads all check-ins and the single shared settings record.
 * - Admins can write; authenticated non-admins are read-only.
 * - Settings edits update local state immediately and auto-save after 500ms.
 *   Concurrent edits are serialized so an old in-flight save cannot overwrite
 *   newer typing.
 * - Subscription events trigger a coalesced requery; remote settings are ignored
 *   while local edits are dirty and reconciled once the save completes.
 */
export function useCashCheckIn(): UseCashCheckIn {
  const { user } = useAuth()

  const [checkins, setCheckins] = useState<CashCheckIn[]>([])
  const [settings, setSettings] = useState<CashSettingsValues>(DEFAULT_CASH_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [backendMissing, setBackendMissing] = useState(false)

  const isAdmin = user?.groups.includes('ADMIN') ?? false
  const userId = user?.userId ?? null
  const canWrite = isAdmin && !backendMissing

  const aliveRef = useRef(true)
  const settingsRef = useRef(settings)
  const dirtyRef = useRef(false)
  const genRef = useRef(0)
  const sentGenRef = useRef(0)
  const savePromiseRef = useRef<Promise<void> | null>(null)
  const scheduleTimerRef = useRef<number | undefined>(undefined)
  const refreshPendingRef = useRef(false)
  const refreshTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // ── Initial load ───────────────────────────────────────────────────────────
  // Runs once per signed-in user. Seeding the shared "default" settings row is limited
  // to ADMIN group members; a read-only user simply projects from the defaults.
  useEffect(() => {
    if (!userId) return
    let alive = true
    ;(async () => {
      try {
        const [fetchedCheckins, fetchedSettings] = await Promise.all([
          listCashCheckIns(),
          getCashSettings(),
        ])
        if (!alive) return
        setCheckins(sortCheckins(fetchedCheckins))
        if (fetchedSettings) {
          setSettings(fetchedSettings)
        } else if (isAdmin) {
          try {
            const created = await createCashSettings(DEFAULT_CASH_SETTINGS)
            if (alive) setSettings(created)
          } catch (err) {
            if (!isConflictError(err)) throw err
            const existing = await getCashSettings()
            if (alive && existing) setSettings(existing)
          }
        }
        if (alive) setLoading(false)
      } catch (err) {
        if (!alive) return
        if (isSchemaMissingError(err)) {
          setBackendMissing(true)
        } else {
          setError(errorMessage(err))
        }
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [userId, isAdmin])

  // ── Subscriptions ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (loading || backendMissing) return
    let unsubCheckins = () => {}
    let unsubSettings = () => {}
    try {
      unsubCheckins = subscribeCashCheckIns(
        () => scheduleRefresh(),
        (err) => handleAsyncError(err),
      )
      unsubSettings = subscribeCashSettings(
        () => scheduleRefresh(),
        (err) => handleAsyncError(err),
        'default',
      )
    } catch (err) {
      handleAsyncError(err)
    }
    return () => {
      unsubCheckins()
      unsubSettings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, backendMissing])

  function handleAsyncError(err: unknown) {
    if (!aliveRef.current) return
    if (isSchemaMissingError(err)) {
      setBackendMissing(true)
    } else {
      setError(errorMessage(err))
    }
  }

  function scheduleRefresh() {
    if (!aliveRef.current) return
    refreshPendingRef.current = true
    if (refreshTimerRef.current) return
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined
      if (!refreshPendingRef.current) return
      refreshPendingRef.current = false
      void performRefresh()
    }, 150)
  }

  async function performRefresh() {
    try {
      const [fetchedCheckins, fetchedSettings] = await Promise.all([
        listCashCheckIns(),
        getCashSettings(),
      ])
      if (!aliveRef.current) return
      setCheckins(sortCheckins(fetchedCheckins))
      if (fetchedSettings && !dirtyRef.current) {
        setSettings(fetchedSettings)
      }
    } catch (err) {
      handleAsyncError(err)
    }
  }

  // ── Settings autosave ──────────────────────────────────────────────────────
  const updateSettings = useCallback((next: CashSettingsValues) => {
    genRef.current += 1
    setSettings(next)
    settingsRef.current = next
    dirtyRef.current = true
    setSettingsSaving(true)
    window.clearTimeout(scheduleTimerRef.current)
    scheduleTimerRef.current = window.setTimeout(() => {
      scheduleTimerRef.current = undefined
      // Failure is already surfaced through `error`; nothing awaits this timer.
      commitSettings(genRef.current).catch(() => {})
    }, 500)
    // commitSettings only touches refs and state setters, so it is stable enough to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function commitSettings(requestedGen: number) {
    // Serialize saves: wait for any in-flight save, then send the latest settings.
    while (savePromiseRef.current) {
      try {
        await savePromiseRef.current
      } catch {
        // error handled inside the in-flight promise
      }
      requestedGen = genRef.current
    }
    if (requestedGen === sentGenRef.current && !dirtyRef.current) {
      setSettingsSaving(false)
      return
    }
    const toSave = settingsRef.current
    sentGenRef.current = requestedGen
    const promise = (async () => {
      try {
        await updateCashSettings(toSave, 'default')
        if (!aliveRef.current) return
        if (genRef.current === sentGenRef.current) {
          dirtyRef.current = false
        }
        setError(null)
      } catch (err) {
        handleAsyncError(err)
        throw err
      } finally {
        if (aliveRef.current) setSettingsSaving(false)
      }
    })()
    savePromiseRef.current = promise
    try {
      await promise
    } finally {
      savePromiseRef.current = null
    }
  }

  // ── Check-in CRUD ──────────────────────────────────────────────────────────
  const saveCheckIn = useCallback(
    async (input: CashCheckInInput, id?: string) => {
      if (!canWrite) throw new Error('You do not have permission to save check-ins')
      setSaving(true)
      setError(null)
      try {
        const validated = validateCashCheckIn(input)
        if (id) {
          const updated = await updateCashCheckIn(id, validated)
          if (!aliveRef.current) return
          setCheckins((prev) => sortCheckins(prev.map((c) => (c.id === id ? updated : c))))
        } else {
          const created = await createCashCheckIn({ ...validated, createdBy: user?.email ?? '' })
          if (!aliveRef.current) return
          // Replace by id only — the backend does not enforce one row per date, so a
          // same-date row that still exists there must not vanish from the table.
          setCheckins((prev) => sortCheckins([...prev.filter((c) => c.id !== created.id), created]))
        }
      } catch (err) {
        handleAsyncError(err)
        throw new Error(errorMessage(err), { cause: err })
      } finally {
        if (aliveRef.current) setSaving(false)
      }
    },
    [canWrite, user?.email],
  )

  const deleteCheckIn = useCallback(
    async (id: string) => {
      if (!canWrite) throw new Error('You do not have permission to delete check-ins')
      setSaving(true)
      setError(null)
      try {
        await deleteCashCheckInClient(id)
        if (!aliveRef.current) return
        setCheckins((prev) => prev.filter((c) => c.id !== id))
      } catch (err) {
        handleAsyncError(err)
        throw new Error(errorMessage(err), { cause: err })
      } finally {
        if (aliveRef.current) setSaving(false)
      }
    },
    [canWrite],
  )

  const importCheckIns = useCallback(
    async (rows: CashCheckInInput[]) => {
      if (!canWrite) throw new Error('You do not have permission to import check-ins')
      const validated = rows.map((r, i) => {
        try {
          return validateCashCheckIn(r)
        } catch (err) {
          throw new Error(`Row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
        }
      })
      const existingDates = new Set(checkins.map((c) => c.date))
      const seenDates = new Set<string>()
      const toCreate: CashCheckInInput[] = []
      let skipped = 0
      for (const row of validated) {
        if (existingDates.has(row.date) || seenDates.has(row.date)) {
          skipped += 1
          continue
        }
        seenDates.add(row.date)
        toCreate.push(row)
      }
      const created = await Promise.all(
        toCreate.map((row) => createCashCheckIn({ ...row, createdBy: user?.email ?? '' })),
      )
      if (!aliveRef.current) return { imported: created.length, skipped }
      setCheckins((prev) => sortCheckins([...prev, ...created]))
      return { imported: created.length, skipped }
    },
    [canWrite, checkins, user?.email],
  )

  useEffect(() => {
    return () => {
      aliveRef.current = false
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = undefined
      // A debounced settings save must not be lost by navigating away within 500 ms of
      // the last edit — the header said "Saving…". commitSettings only reads refs and
      // its setState calls are aliveRef-guarded, so flushing after unmount is safe.
      if (scheduleTimerRef.current) {
        window.clearTimeout(scheduleTimerRef.current)
        scheduleTimerRef.current = undefined
        commitSettings(genRef.current).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    checkins,
    settings,
    canWrite,
    loading,
    saving,
    settingsSaving,
    error,
    backendMissing,
    updateSettings,
    saveCheckIn,
    deleteCheckIn,
    importCheckIns,
  }
}
