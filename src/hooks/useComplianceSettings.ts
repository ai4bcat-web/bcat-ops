import { useState, useEffect, useCallback } from 'react'
import { ensureComplianceSettings, updateComplianceSettings } from '@/lib/complianceClient'
import type { ComplianceSettings } from '@/types'

/** GLOBAL compliance settings: email kill switches (both default PAUSED) + manager recipients. */
export function useComplianceSettings() {
  const [settings, setSettings] = useState<ComplianceSettings | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setSettings(await ensureComplianceSettings())
    } catch (err) {
      console.error('[useComplianceSettings] load error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const patch = useCallback(
    async (changes: Partial<Pick<ComplianceSettings, 'portalEmailsPaused' | 'escalationEmailsPaused' | 'managerEmails'>>) => {
      if (!settings) return
      const updated = await updateComplianceSettings(settings.id, changes)
      setSettings(updated)
      return updated
    },
    [settings],
  )

  return { settings, loading, refresh: load, patch }
}
