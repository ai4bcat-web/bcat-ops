import { useState } from 'react'
import { toast } from 'sonner'
import { Rocket, Send, Copy, Check, CircleCheck, Circle, Clock } from 'lucide-react'
import { useDriverOnboarding } from '@/hooks/useDriverOnboarding'
import { applicationFormFor, canSendApplication, driverStatus, showsOnboardingPercent, DRIVER_STATUS_LABELS, statusAfterToggle } from '@/lib/driverOnboarding'
import { useAppStore } from '@/store/useAppStore'
import { FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { Driver, OnboardingTask } from '@/types'

/**
 * Onboarding, inside the driver's file.
 *
 * Shows how far along the driver is, lets the office kick the process off, and sends
 * them the application form for their fleet. The checklist here is the SAME
 * OnboardingTask data the Compliance pages use — a different view, not a second list.
 */
export function DriverOnboardingSection({ driver }: { driver: Driver }) {
  const { grouped, progress, loading, busy, start, sendApplication, toggleTask } = useDriverOnboarding(driver)
  const [portalUrl, setPortalUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const updateDriver = useAppStore((st) => st.updateDriver)

  const form = applicationFormFor(driver.fleetGroup)
  const canSend = canSendApplication(driver)
  const status = driverStatus(driver, progress)
  // A checklist and a percentage only mean something mid-onboarding. An active driver
  // who finished — or an established one who never had a checklist — shouldn't carry a
  // permanent to-do list implying they're incomplete.
  const showChecklist = showsOnboardingPercent(status)

  /**
   * Whether onboarding can be started at all.
   *
   * An established, already-active driver isn't offered it — they're working, not being
   * hired. NOT_STARTED is the exception: new drivers are created with it, so a fresh
   * hire can still be onboarded even though they read as Active until you begin.
   * Without that distinction, "hide it for active drivers" would make it impossible to
   * onboard anyone new.
   */
  const canStartOnboarding = driver.onboardingStatus === 'NOT_STARTED' || showChecklist

  const handleStart = async () => {
    try {
      await start()
      toast.success(`Onboarding checklist ready for ${driver.name}`)
    } catch (err) {
      toast.error(`Couldn't start onboarding: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const handleSend = async () => {
    try {
      const url = await sendApplication()
      if (!url) { toast.error(canSend.reason ?? 'Could not create the application link'); return }
      setPortalUrl(url)
      toast.success('Application link created')
    } catch (err) {
      toast.error(`Couldn't send the application: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const copy = () => {
    if (!portalUrl) return
    void navigator.clipboard.writeText(portalUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const barColor = progress.percent === 100 ? '#15803d' : progress.percent >= 50 ? '#1ea8f3' : '#b45309'

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Onboarding</div>
        <span style={{
          fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
          color: status === 'ACTIVE' ? '#15803d' : status === 'ONBOARDING' ? '#b45309' : 'var(--ds-t3)',
          background: status === 'ACTIVE' ? '#f0fdf4' : status === 'ONBOARDING' ? '#fffbeb' : 'var(--ds-bg)',
        }}>{DRIVER_STATUS_LABELS[status]}</span>
        {driver.fleetGroup && (
          <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{FLEET_GROUP_LABELS[driver.fleetGroup]}</span>
        )}
        <div style={{ flex: 1 }} />
        {/* You control active vs inactive. Onboarding is not selectable — a driver sits
            there until every box is ticked and then becomes Active on their own. */}
        <button
          onClick={async () => {
            const next = driver.active === false
            try {
              await updateDriver(driver.id, { active: next })
              toast.success(next ? `${driver.name} set to active` : `${driver.name} set to inactive`)
            } catch (err) {
              toast.error(`Couldn't change status: ${err instanceof Error ? err.message : 'unknown error'}`)
            }
          }}
          title={driver.active === false
            ? `Reactivate — they will show as ${DRIVER_STATUS_LABELS[statusAfterToggle(driver, progress)]}`
            : 'Set inactive'}
          style={{ height: 24, padding: '0 10px', borderRadius: 999, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
          {driver.active === false ? 'Set active' : 'Set inactive'}
        </button>
      </div>

      {/* Progress and checklist are shown ONLY while the driver is onboarding — an
          active driver shouldn't carry a permanent to-do list implying they're
          incomplete, and a percentage means nothing once hiring is done. */}
      {showChecklist && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ flex: 1, height: 8, borderRadius: 999, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', overflow: 'hidden' }}>
              <div style={{ width: `${progress.percent}%`, height: '100%', background: barColor, transition: 'width .2s' }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', minWidth: 42, textAlign: 'right' }}>
              {progress.percent}%
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginBottom: 10 }}>
            {loading ? 'Loading…'
              : <>
                  {progress.done} of {progress.applicable} done
                  {progress.awaitingDriver > 0 && ` · ${progress.awaitingDriver} waiting on the driver`}
                  {progress.awaitingReview > 0 && ` · ${progress.awaitingReview} to review`}
                </>}
          </div>
        </>
      )}

      {/* Actions */}
      {canStartOnboarding && (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button onClick={handleStart} disabled={busy}
          title="Create (or top up) this driver's checklist from the requirement catalog"
          style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
          <Rocket size={13} /> {progress.applicable === 0 ? 'Start onboarding' : 'Refresh checklist'}
        </button>

        <button onClick={handleSend} disabled={busy || !canSend.ok}
          title={canSend.ok ? `Send ${form?.label}` : canSend.reason}
          style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: canSend.ok ? 'var(--ds-blue)' : 'var(--ds-border)', color: canSend.ok ? '#fff' : 'var(--ds-t3)', fontSize: 12, fontWeight: 600, cursor: canSend.ok && !busy ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
          <Send size={13} /> Send application
        </button>
      </div>
      )}

      {!canStartOnboarding && (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginBottom: 10 }}>
          {status === 'ACTIVE'
            ? 'Already active — onboarding isn’t offered for a driver who is already working.'
            : 'Set the driver active to begin onboarding.'}
        </div>
      )}

      {!canSend.ok && (
        <div style={{ fontSize: 11.5, color: '#b45309', marginBottom: 10 }}>{canSend.reason}</div>
      )}
      {form && canSend.ok && (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginBottom: 10 }}>{form.label} — {form.blurb}</div>
      )}

      {portalUrl && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', marginBottom: 10 }}>
          <span style={{ flex: 1, fontSize: 11.5, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)' }}>{portalUrl}</span>
          <button onClick={copy} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--ds-blue)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy link</>}
          </button>
        </div>
      )}

      {/* Checklist — documents AND the action items that have no file attached */}
      {showChecklist && grouped.map(({ category, tasks }) => (
        <div key={category} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '6px 0 3px' }}>{category}</div>
          {tasks.map((t) => <TaskRow key={t.id} task={t} onToggle={() => void toggleTask(t)} />)}
        </div>
      ))}
    </div>
  )
}

function TaskRow({ task, onToggle }: { task: OnboardingTask; onToggle: () => void }) {
  const done = task.status === 'COMPLETE' || task.status === 'WAIVED'
  const na = task.status === 'NOT_APPLICABLE'
  const pendingReview = task.status === 'PENDING_REVIEW'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5, opacity: na ? 0.45 : 1 }}>
      <button onClick={onToggle} disabled={na}
        title={done ? 'Mark not done' : 'Mark done'}
        style={{ display: 'flex', background: 'none', border: 'none', padding: 0, cursor: na ? 'default' : 'pointer', color: done ? '#15803d' : 'var(--ds-t3)' }}>
        {done ? <CircleCheck size={15} /> : <Circle size={15} />}
      </button>
      <span style={{ flex: 1, color: done ? 'var(--ds-t3)' : 'var(--ds-t1)', textDecoration: done ? 'line-through' : undefined }}>
        {task.label}
        {task.required === false && <span style={{ color: 'var(--ds-t3)', fontSize: 11 }}> · optional</span>}
      </span>
      {pendingReview && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 600, color: '#b45309', background: '#fffbeb', padding: '2px 7px', borderRadius: 999 }}>
          <Clock size={11} /> To review
        </span>
      )}
      {na && <span style={{ fontSize: 10.5, color: 'var(--ds-t3)' }}>N/A</span>}
    </div>
  )
}
