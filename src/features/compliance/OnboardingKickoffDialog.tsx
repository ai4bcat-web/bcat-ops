import { useState } from 'react'
import { Link as LinkIcon, Copy as CopyIcon, Check as CheckIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useStartOnboarding } from '@/hooks/useStartOnboarding'
import { useOnboardingInvites } from '@/hooks/useOnboardingInvites'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import { buildPortalUrl, generateTemplateChecklist, writeComplianceAudit } from '@/lib/complianceClient'
import { ONBOARDING_TEMPLATES, getOnboardingTemplate } from '@/lib/onboardingTemplates'
import type { Driver, DriverType } from '@/types'

// null = the standard flat Ivan/Local checklist; otherwise a phased template id.
const STANDARD = 'STANDARD'

interface Props {
  driver: Driver
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OnboardingKickoffDialog({ driver, open, onOpenChange }: Props) {
  const { startOnboarding, isStarting } = useStartOnboarding()
  const { createInvite } = useOnboardingInvites(driver.id)
  const { user } = useAuth()
  const updateDriver = useAppStore((s) => s.updateDriver)

  const [classification, setClassification] = useState<DriverType>(driver.driverType ?? 'COMPANY')
  const [templateId, setTemplateId] = useState<string>(driver.onboardingTemplateId ?? STANDARD)
  const [email, setEmail] = useState(driver.email ?? '')
  const [internalOnly, setInternalOnly] = useState(false)
  const [portalUrl, setPortalUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleStart() {
    if (!internalOnly && !email.trim()) {
      toast.error('Enter an email to send the invite, or choose Internal only')
      return
    }
    setBusy(true)
    try {
      const template = templateId === STANDARD ? null : getOnboardingTemplate(templateId)
      if (template) {
        const { created } = await generateTemplateChecklist({ driverId: driver.id, driverType: classification, template })
        await writeComplianceAudit({
          entityType: 'DRIVER', entityId: driver.id, action: 'onboarding_started',
          user: user?.email ?? 'unknown',
          changes: { classification, templateId: template.id, created },
        })
      } else {
        await startOnboarding({ entityType: 'DRIVER', entityId: driver.id, classification })
      }
      await updateDriver(driver.id, {
        driverType: classification,
        email: email.trim() || driver.email,
        onboardingStatus: internalOnly ? 'IN_PROGRESS' : 'INVITED',
        onboardingTemplateId: template ? template.id : null,
      })
      if (internalOnly) {
        toast.success(`Checklist generated for ${driver.name} (internal only)`)
        onOpenChange(false)
      } else {
        const invite = await createInvite(email.trim(), classification)
        setPortalUrl(buildPortalUrl(invite.token))
      }
    } catch (err) {
      console.error('[kickoff] failed', err)
      toast.error('Could not start onboarding')
    } finally {
      setBusy(false)
    }
  }

  function copyLink() {
    if (!portalUrl) return
    navigator.clipboard.writeText(portalUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function close() {
    setPortalUrl(null)
    setCopied(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        {!portalUrl ? (
          <>
            <DialogHeader>
              <DialogTitle>Start onboarding — {driver.name}</DialogTitle>
              <DialogDescription>
                Classify the driver, generate their DOT checklist, and (optionally) issue a portal invite.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Onboarding template</Label>
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm"
                >
                  <option value={STANDARD}>Standard (Ivan / Local — flat checklist)</option>
                  {ONBOARDING_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label} — {t.phases.length}-phase</option>
                  ))}
                </select>
                {templateId !== STANDARD && (
                  <p className="text-xs" style={{ color: 'var(--ds-t3)' }}>
                    Phased flow: the driver only sees the current phase; truck tasks generate on the assigned
                    truck once Phase 2 completes.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Classification</Label>
                <div className="flex gap-2">
                  {(['COMPANY', 'OWNER_OPERATOR'] as DriverType[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setClassification(c)}
                      className="flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
                      style={classification === c
                        ? { borderColor: 'var(--ds-blue)', background: 'var(--ds-blue-soft)', color: 'var(--ds-blue)' }
                        : { borderColor: 'var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)' }}
                    >
                      {c === 'COMPANY' ? 'Company Driver' : 'Owner-Operator'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Invite email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="driver@example.com"
                  disabled={internalOnly}
                  className="h-9"
                />
              </div>

              <label className="flex items-center justify-between rounded-lg px-3 py-2" style={{ border: '1px solid var(--ds-border)' }}>
                <div>
                  <div className="text-sm font-medium" style={{ color: 'var(--ds-t1)' }}>Internal only</div>
                  <div className="text-xs" style={{ color: 'var(--ds-t3)' }}>Generate the checklist without sending a portal invite (backfill).</div>
                </div>
                <Switch checked={internalOnly} onCheckedChange={setInternalOnly} />
              </label>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={handleStart} disabled={busy || isStarting}>
                {busy ? 'Working…' : internalOnly ? 'Generate checklist' : 'Create invite'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <LinkIcon size={16} /> Invite ready for {email}
              </DialogTitle>
              <DialogDescription>
                Share this secure onboarding link with the driver. It's also emailed to them automatically
                when portal emails are enabled, and stays valid for 14 days.
              </DialogDescription>
            </DialogHeader>

            <div className="py-1">
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ds-t3)', marginBottom: 6 }}>
                Portal link
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '6px 8px' }}>
                <input
                  readOnly
                  value={portalUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontSize: 12.5, color: 'var(--ds-t2)', fontFamily: 'var(--font-mono)', textOverflow: 'ellipsis' }}
                />
                <Button size="sm" variant="outline" onClick={copyLink}>
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
