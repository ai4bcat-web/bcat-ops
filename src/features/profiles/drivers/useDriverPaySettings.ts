import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createDriverPaySetting, listDriverPaySettings, updateDriverPaySetting, type DriverPaySetting,
} from '@/lib/apiClient'

export type PaySettingPatch = Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>

/**
 * Every driver's stored pay setting, and the one save path. These are the SAME DriverPaySetting
 * rows the Amazon, Box Truck and Owner Operator settlement pages read and write (same list, create
 * and update calls, the same optimistic-concurrency `expectedUpdatedAt`), so editing pay on a
 * profile changes the next settlement exactly as editing it on the settlement page does.
 */
export function useDriverPaySettings() {
  const [settings, setSettings] = useState<DriverPaySetting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => listDriverPaySettings()
    .then((rows) => { setSettings(rows); setError(null) })
    .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
    .finally(() => setLoading(false)), [])
  useEffect(() => { void load() }, [load])

  const byDriver = useMemo(() => new Map(settings.map((s) => [s.driverId, s])), [settings])

  const save = useCallback(async (driverId: string, patch: PaySettingPatch, expectedUpdatedAt: string | undefined) => {
    const existing = settings.find((s) => s.driverId === driverId)
    if (existing) {
      const updated = await updateDriverPaySetting(existing.id, patch, expectedUpdatedAt ?? '')
      setSettings((prev) => prev.map((s) => (s.id === existing.id ? updated : s)))
      return updated
    }
    const created = await createDriverPaySetting({ driverId, ...patch })
    setSettings((prev) => [...prev, created])
    return created
  }, [settings])

  return { settings, byDriver, loading, error, save, refresh: load }
}
