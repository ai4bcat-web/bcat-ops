import { useState } from 'react'
import { Copy, Check, RefreshCw, Ban, CalendarPlus, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useOnboardingInvites } from '@/hooks/useOnboardingInvites'
import { useOnboardingTasks } from '@/hooks/useOnboardingTasks'
import { buildPortalUrl } from '@/lib/complianceClient'
import { daysRemainingLabel, Card } from './components'
import type { Driver, OnboardingInviteStatus } from '@/types'

const INVITE_BADGE: Record<OnboardingInviteStatus, { variant: 'default' | 'green' | 'secondary' | 'orange' | 'destructive'; label: string }> = {
  SENT: { variant: 'default', label: 'Sent' },
  OPENED: { variant: 'default', label: 'Opened' },
  IN_PROGRESS: { variant: 'orange', label: 'In progress' },
  SUBMITTED: { variant: 'green', label: 'Submitted' },
  EXPIRED: { variant: 'secondary', label: 'Expired' },
  REVOKED: { variant: 'destructive', label: 'Revoked' },
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function InvitePanel({ driver }: { driver: Driver }) {
  const { activeInvite, loading, createInvite, revokeInvite, resendInvite, extendInvite } = useOnboardingInvites(driver.id)
  const { tasks } = useOnboardingTasks('DRIVER', driver.id)
  // An invite with no checklist behind it hands the driver an empty portal — block it.
  const hasChecklist = tasks.length > 0
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const url = activeInvite ? buildPortalUrl(activeInvite.token) : null

  function copyLink() {
    if (!url) return
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function withBusy(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); toast.success(ok) }
    catch (e) { console.error(e); toast.error('Action failed') }
    finally { setBusy(false) }
  }

  return (
    <Card title="Portal invite" sub="Driver self-service onboarding link">
      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : !activeInvite ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>No active invite for this driver.</div>
          <Button
            size="sm"
            disabled={busy || !driver.email || !hasChecklist}
            onClick={() => withBusy(() => createInvite(driver.email!, driver.driverType ?? 'COMPANY'), 'Invite created')}
          >
            <Mail size={14} /> Create invite
          </Button>
          {!driver.email && <div style={{ fontSize: 12, color: '#dc2626' }}>Add an email to the driver first.</div>}
          {!hasChecklist && (
            <div style={{ fontSize: 12, color: '#b45309' }}>
              No checklist yet — use <strong>Start onboarding</strong> above to generate the steps first, or the driver gets an empty portal.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge variant={INVITE_BADGE[activeInvite.status].variant}>{INVITE_BADGE[activeInvite.status].label}</Badge>
            <span style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>
              Expires {daysRemainingLabel(activeInvite.expiresAt.slice(0, 10))}
            </span>
          </div>

          {/* Live portal activity (Phase 3 writes these) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
            <div><span style={{ color: 'var(--ds-t3)' }}>Sent:</span> {fmtDateTime(activeInvite.sentAt)}</div>
            <div><span style={{ color: 'var(--ds-t3)' }}>Opened:</span> {fmtDateTime(activeInvite.openedAt)}</div>
            <div><span style={{ color: 'var(--ds-t3)' }}>Last activity:</span> {fmtDateTime(activeInvite.lastActivityAt)}</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '6px 8px' }}>
            <input readOnly value={url ?? ''} onFocus={(e) => e.currentTarget.select()}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 12.5, color: 'var(--ds-t2)' }} />
            <Button size="sm" variant="outline" style={{ paddingInline: 16 }} onClick={copyLink}>
              {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" variant="outline" style={{ paddingInline: 16 }} disabled={busy}
              onClick={() => withBusy(() => resendInvite(activeInvite), 'New invite issued (old one revoked)')}>
              <RefreshCw size={14} /> Resend
            </Button>
            <Button size="sm" variant="outline" style={{ paddingInline: 16 }} disabled={busy}
              onClick={() => withBusy(() => extendInvite(activeInvite.id, 14), 'Expiration extended 14 days')}>
              <CalendarPlus size={14} /> Extend
            </Button>
            <Button size="sm" variant="destructive" style={{ paddingInline: 16 }} disabled={busy}
              onClick={() => withBusy(() => revokeInvite(activeInvite.id), 'Invite revoked')}>
              <Ban size={14} /> Revoke
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
