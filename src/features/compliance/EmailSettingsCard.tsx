/**
 * Admin email controls: portal + escalation kill switches (default PAUSED) + manager
 * recipients.
 *
 * Only My Brokerage → Settings renders this, so it wears the MVMNT kit rather than the
 * compliance pages' own `Card` chrome; the compliance pages themselves are untouched.
 */
import { useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Mail, Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsInput } from '@/features/tms/kit'
import { useComplianceSettings } from '@/hooks/useComplianceSettings'

export function EmailSettingsCard() {
  const { settings, loading, patch } = useComplianceSettings()
  const [managerEmails, setManagerEmails] = useState('')
  const [dirty, setDirty] = useState(false)
  const defaultEmails = useMemo(() => settings?.managerEmails?.join(', ') ?? '', [settings?.managerEmails])
  const displayed = dirty ? managerEmails : defaultEmails

  async function toggle(key: 'portalEmailsPaused' | 'escalationEmailsPaused', paused: boolean) {
    await patch({ [key]: paused })
    toast.success(paused ? 'Emails paused' : 'Emails enabled')
  }

  async function saveManagers() {
    const emails = displayed.split(',').map((s) => s.trim()).filter(Boolean)
    await patch({ managerEmails: emails })
    setDirty(false)
    toast.success('Manager recipients saved')
  }

  return (
    <TmsCard title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Mail size={14} aria-hidden="true" />Email settings</span>}>
      <p className="tms-field-hint" style={{ margin: '0 0 12px' }}>Both kill switches default to PAUSED until you flip them</p>
      {loading || !settings ? (
        <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>Loading…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Row
            icon={<Mail size={15} />}
            title="Driver portal emails"
            desc="Invite, document-rejected, and onboarding-complete emails to drivers."
            paused={settings.portalEmailsPaused}
            onToggle={(p) => toggle('portalEmailsPaused', p)}
          />
          <Row
            icon={<Mail size={15} />}
            title="Expiration escalation emails"
            desc="Renewal reminders and out-of-service warnings (Phase 4 scanner)."
            paused={settings.escalationEmailsPaused}
            onToggle={(p) => toggle('escalationEmailsPaused', p)}
          />
          <div style={{ borderTop: '1px solid var(--tms-border)', paddingTop: 12 }}>
            <div className="tms-field-label" style={{ marginBottom: 6 }}>Manager recipients (escalation, comma-separated)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <TmsInput
                aria-label="Manager recipients"
                value={displayed}
                onChange={(e) => { setDirty(true); setManagerEmails(e.target.value) }}
                placeholder="ops@bcatcorp.com, safety@bcatcorp.com"
              />
              <TmsButton size="sm" onClick={saveManagers}>Save</TmsButton>
            </div>
          </div>
        </div>
      )}
    </TmsCard>
  )
}

function Row({ icon, title, desc, paused, onToggle }: {
  icon: ReactNode; title: string; desc: string; paused: boolean; onToggle: (paused: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className={paused ? 'tms-muted' : undefined} style={{ marginTop: 2, color: paused ? undefined : 'var(--tms-badge-green)' }}>
          {paused ? <Pause size={15} /> : <Play size={15} />}{icon}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
          <div className="tms-muted" style={{ fontSize: 12 }}>{desc}</div>
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <span
          style={{ fontSize: 12, fontWeight: 600, color: paused ? 'var(--tms-badge-orange)' : 'var(--tms-badge-green)' }}
        >
          {paused ? 'PAUSED' : 'LIVE'}
        </span>
        {/* Ticked = emails live (not paused) */}
        <input
          type="checkbox"
          aria-label={`${title} live`}
          checked={!paused}
          onChange={(e) => onToggle(!e.target.checked)}
          style={{ accentColor: 'var(--tms-primary)', width: 15, height: 15 }}
        />
      </label>
    </div>
  )
}
