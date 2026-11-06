import { useCallback, useEffect, useState } from 'react'
import {
  listDriverPaySettings, createDriverPaySetting, updateDriverPaySetting, createAuditLog,
  type DriverPaySetting,
} from '@/lib/apiClient'
import { withRateChange } from '@/lib/hoursPay'

/**
 * Each driver's hourly rate, for the staff Employee Hours page.
 *
 * Loads NOTHING unless `enabled` (the viewer may see pay): a user without pay access never
 * has a rate fetched into their browser. A driver with no pay setting row gets one on their
 * first rate (payGroup LOCAL, 0% placeholder the model requires) — percent-based settlement
 * reads payGroup AMAZON / OWNER_OPERATOR rows and is untouched. A driver who already has a
 * row of any group keeps that group; only the hourly fields change.
 */
export function useHourlyRates(enabled: boolean, staffEmail: string) {
  const [settings, setSettings] = useState<Map<string, DriverPaySetting>>(new Map())

  useEffect(() => {
    if (!enabled) return
    let stale = false
    listDriverPaySettings()
      .then((rows) => { if (!stale) setSettings(new Map(rows.map((s) => [s.driverId, s]))) })
      .catch((e) => console.warn('[hours] pay settings unavailable', e))
    return () => { stale = true }
  }, [enabled])

  /** Set a driver's rate from a date. Throws the reason (bad rate, date before the current rate began). */
  const saveRate = useCallback(async (driverId: string, rate: number, effectiveFrom: string) => {
    if (!enabled) throw new Error('You do not have access to pay rates.')
    const existing = settings.get(driverId)
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
  }, [enabled, settings, staffEmail])

  return { settings, saveRate }
}
