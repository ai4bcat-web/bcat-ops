import { useState, useEffect } from 'react'
import { Mail, Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useComplianceSettings } from '@/hooks/useComplianceSettings'
import { Card } from './components'

/** Admin email controls: portal + escalation kill switches (default PAUSED) + manager recipients. */
export function EmailSettingsCard() {
  const { settings, loading, patch } = useComplianceSettings()
  const [managerEmails, setManagerEmails] = useState('')

  useEffect(() => {
    if (settings?.managerEmails) setManagerEmails(settings.managerEmails.join(', '))
  }, [settings?.managerEmails])

  async function toggle(key: 'portalEmailsPaused' | 'escalationEmailsPaused', paused: boolean) {
    await patch({ [key]: paused })
    toast.success(paused ? 'Emails paused' : 'Emails enabled')
  }

  async function saveManagers() {
    const emails = managerEmails.split(',').map((s) => s.trim()).filter(Boolean)
    await patch({ managerEmails: emails })
    toast.success('Manager recipients saved')
  }

  return (
    <Card title="Email settings" sub="Both kill switches default to PAUSED until you flip them">
      {loading || !settings ? (
        <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
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
          <div style={{ borderTop: '1px solid var(--ds-border)', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginBottom: 6 }}>Manager recipients (escalation, comma-separated)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={managerEmails} onChange={(e) => setManagerEmails(e.target.value)} placeholder="ops@bcatcorp.com, safety@bcatcorp.com" className="h-9" />
              <Button size="sm" variant="outline" onClick={saveManagers}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

function Row({ icon, title, desc, paused, onToggle }: {
  icon: React.ReactNode; title: string; desc: string; paused: boolean; onToggle: (paused: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ color: paused ? 'var(--ds-t3)' : '#16a34a', marginTop: 2 }}>{paused ? <Pause size={15} /> : <Play size={15} />}{icon}</div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ds-t1)' }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{desc}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: paused ? '#b45309' : '#16a34a' }}>{paused ? 'PAUSED' : 'LIVE'}</span>
        {/* Switch ON = emails live (not paused) */}
        <Switch checked={!paused} onCheckedChange={(v) => onToggle(!v)} />
      </div>
    </div>
  )
}
