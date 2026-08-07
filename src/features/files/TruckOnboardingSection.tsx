import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Rocket, CircleCheck, Circle } from 'lucide-react'
import { listOnboardingTasks, generateChecklist, setTaskStatus } from '@/lib/complianceClient'
import { onboardingProgress, tasksByCategory } from '@/lib/driverOnboarding'
import { useAuth } from '@/hooks/useAuth'
import type { OnboardingTask } from '@/types'
import type { Equipment } from '@/types/equipment'

/**
 * Onboarding for a truck or trailer, inside its file — the same shape drivers have, so
 * bringing a vehicle into service is tracked the way bringing a driver on is.
 *
 * Reads the same OnboardingTask records the retired truck wizard created, so a truck
 * started there continues here without losing its progress.
 */
export function TruckOnboardingSection({ asset }: { asset: Equipment }) {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTasks(await listOnboardingTasks('TRUCK', asset.id))
    } catch (err) {
      console.error('[truck onboarding] load', err)
    } finally { setLoading(false) }
  }, [asset.id])

  useEffect(() => { void load() }, [load])

  const progress = useMemo(() => onboardingProgress(tasks), [tasks])
  const grouped = useMemo(() => tasksByCategory(tasks), [tasks])

  /**
   * Ownership drives which requirements apply. Equipment.ownership is free text
   * ('owned' | 'leased' | …), so it's mapped to the catalog's classification here.
   */
  const classification = asset.ownership === 'leased' ? 'LEASED'
    : asset.ownership === 'owned' ? 'COMPANY'
    : 'OWNER_OPERATOR'

  const start = async () => {
    setBusy(true)
    try {
      await generateChecklist({ entityType: 'TRUCK', entityId: asset.id, classification })
      await load()
      toast.success(`Checklist ready for #${asset.unitNumber}`)
    } catch (err) {
      toast.error(`Couldn't start: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally { setBusy(false) }
  }

  const toggle = async (task: OnboardingTask) => {
    const next = task.status === 'COMPLETE' ? 'PENDING' : 'COMPLETE'
    try {
      const updated = await setTaskStatus(task.id, next, { completedBy: user?.email ?? 'unknown' })
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)))
    } catch (err) {
      toast.error(`Couldn't update: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  // Nothing to show until someone starts it — an untouched truck shouldn't carry a
  // permanent 0% implying it's incomplete.
  const started = progress.applicable > 0
  const barColor = progress.percent === 100 ? '#15803d' : progress.percent >= 50 ? '#1ea8f3' : '#b45309'

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Onboarding</div>
        {started && (
          <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{progress.done} of {progress.applicable} done</span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={start} disabled={busy}
          title="Create (or top up) this asset's checklist from the requirement catalog"
          style={{ display: 'flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 11.5, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
          <Rocket size={12} /> {started ? 'Refresh checklist' : 'Start onboarding'}
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : !started ? (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
          No checklist yet — start onboarding to track this asset into service.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1, height: 8, borderRadius: 999, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', overflow: 'hidden' }}>
              <div style={{ width: `${progress.percent}%`, height: '100%', background: barColor, transition: 'width .2s' }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', minWidth: 42, textAlign: 'right' }}>
              {progress.percent}%
            </span>
          </div>

          {grouped.map(({ category, tasks: rows }) => (
            <div key={category} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '6px 0 3px' }}>{category}</div>
              {rows.map((t) => {
                const done = t.status === 'COMPLETE' || t.status === 'WAIVED'
                const na = t.status === 'NOT_APPLICABLE'
                return (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5, opacity: na ? 0.45 : 1 }}>
                    <button onClick={() => void toggle(t)} disabled={na}
                      style={{ display: 'flex', background: 'none', border: 'none', padding: 0, cursor: na ? 'default' : 'pointer', color: done ? '#15803d' : 'var(--ds-t3)' }}>
                      {done ? <CircleCheck size={15} /> : <Circle size={15} />}
                    </button>
                    <span style={{ flex: 1, color: done ? 'var(--ds-t3)' : 'var(--ds-t1)', textDecoration: done ? 'line-through' : undefined }}>
                      {t.label}
                    </span>
                    {na && <span style={{ fontSize: 10.5, color: 'var(--ds-t3)' }}>N/A</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
