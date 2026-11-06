import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting, createAuditLog,
  type DriverPaySetting,
} from '@/lib/apiClient'
import { withRateChange } from '@/lib/hoursPay'
import { errorText } from '@/lib/errorText'

/**
 * Each driver's hourly rate, for the staff Employee Hours page.
 *
 * Loads NOTHING unless `enabled` (the viewer may see pay): a user without pay access never
 * has a rate fetched into their browser. A driver with no pay setting row gets one on their
 * first rate (payGroup LOCAL, 0% placeholder the model requires) — percent-based settlement
 * reads payGroup AMAZON / OWNER_OPERATOR rows and is untouched. A driver who already has a
 * row of any group keeps that group; only the hourly fields change.
 */
export type RatesStatus = 'off' | 'loading' | 'ready' | 'error'

export function useHourlyRates(enabled: boolean, staffEmail: string) {
  const [settings, setSettings] = useState<Map<string, DriverPaySetting>>(new Map())
  const [status, setStatus] = useState<RatesStatus>(enabled ? 'loading' : 'off')
  const [error, setError] = useState<string | null>(null)
  const [loadKey, setLoadKey] = useState(0)
  // Drivers with a save in flight: a second click, or a second editor, cannot start another.
  const saving = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled) return
    let stale = false
    listDriverPaySettings()
      .then((rows) => { if (!stale) { setSettings(new Map(rows.map((s) => [s.driverId, s]))); setError(null); setStatus('ready') } })
      .catch((e) => { if (!stale) { setError(errorText(e)); setStatus('error') } })
    return () => { stale = true }
  }, [enabled, loadKey])

  /** Try the load again after a failure. */
  const reload = useCallback(() => { setStatus('loading'); setLoadKey((k) => k + 1) }, [])

  /**
   * Set a driver's rate from a date. Throws the reason (bad rate, date before the current rate
   * began, rates not loaded). Rates that failed to load are never guessed at: editing waits.
   */
  const saveRate = useCallback(async (driverId: string, rate: number, effectiveFrom: string) => {
    if (!enabled) throw new Error('You do not have access to pay rates.')
    if (status !== 'ready') throw new Error('Rates have not loaded yet, so a rate cannot be saved safely. Reload them first.')
    if (saving.current.has(driverId)) throw new Error('This rate is already being saved.')
    saving.current.add(driverId)
    try {
      let existing = settings.get(driverId)
      if (!existing) {
        // First rate: look again right before creating, so a row made since this page loaded
        // (another tab, a double save) is reused instead of duplicated.
        const fresh = (await listDriverPaySettings()).filter((s) => s.driverId === driverId)
        existing = fresh.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      }
      const at = new Date().toISOString()
      const next = withRateChange(existing ?? {}, rate, effectiveFrom, staffEmail, at)
      const saved = existing
        ? await updateDriverPaySetting(existing.id, next, existing.updatedAt)
        : await createDriverPaySetting({ driverId, payGroup: 'LOCAL', payPercent: 0, expensesBeforePercent: false, active: true, ...next })
      setSettings((m) => new Map(m).set(driverId, saved))
      // Who changed whose rate, and from when: the audit trail for a number payroll runs on.
      await createAuditLog({
        entityType: 'Driver', entityId: driverId, action: 'update', user: staffEmail,
        changes: { hourlyRate: { from: existing?.hourlyRate ?? null, to: rate }, effectiveFrom: { from: null, to: effectiveFrom } },
      }).catch((e) => console.warn('[hours] rate audit not written', e))
      return saved
    } finally {
      saving.current.delete(driverId)
    }
  }, [enabled, status, settings, staffEmail])

  return { settings, status, error, reload, saveRate }
}
