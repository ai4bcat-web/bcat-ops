import { useState, useEffect, useCallback } from 'react'
import { ensureComplianceSettings, updateComplianceSettings } from '@/lib/complianceClient'
import { setPrivateDocTypes, setResponsibilityOverrides, type Responsibility } from '@/lib/fileHub'
import type { ComplianceSettings } from '@/types'

/** GLOBAL compliance settings: email kill switches (both default PAUSED) + manager recipients. */
export function useComplianceSettings() {
  const [settings, setSettings] = useState<ComplianceSettings | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const loaded = await ensureComplianceSettings()
      setSettings(loaded)
      // Apply the configured private-document list app-wide. Until this resolves the
      // defaults stand, so a slow or failed load errs toward hiding, not exposing.
      setPrivateDocTypes(loaded.privateDocumentTypes)
      setResponsibilityOverrides(loaded.documentResponsibility as Record<string, Responsibility> | null)
    } catch (err) {
      console.error('[useComplianceSettings] load error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const patch = useCallback(
    async (changes: Partial<Pick<ComplianceSettings, 'portalEmailsPaused' | 'escalationEmailsPaused' | 'managerEmails' | 'privateDocumentTypes' | 'documentResponsibility'>>) => {
      if (!settings) return
      const updated = await updateComplianceSettings(settings.id, changes)
      setSettings(updated)
      if (changes.privateDocumentTypes !== undefined) setPrivateDocTypes(updated.privateDocumentTypes)
      if (changes.documentResponsibility !== undefined) {
        setResponsibilityOverrides(updated.documentResponsibility as Record<string, Responsibility> | null)
      }
      return updated
    },
    [settings],
  )

  return { settings, loading, refresh: load, patch }
}
