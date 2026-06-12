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
import { useAppStore } from '@/store/useAppStore'
import { buildPortalUrl } from '@/lib/complianceClient'
import type { Driver, DriverType } from '@/types'

interface Props {
  driver: Driver
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OnboardingKickoffDialog({ driver, open, onOpenChange }: Props) {
  const { startOnboarding, isStarting } = useStartOnboarding()
  const { createInvite } = useOnboardingInvites(driver.id)
  const updateDriver = useAppStore((s) => s.updateDriver)

  const [classification, setClassification] = useState<DriverType>(driver.driverType ?? 'COMPANY')
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
      await startOnboarding({ entityType: 'DRIVER', entityId: driver.id, classification })
      await updateDriver(driver.id, {
        driverType: classification,
        email: email.trim() || driver.email,
        onboardingStatus: internalOnly ? 'IN_PROGRESS' : 'INVITED',
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
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Classification</Label>
                <div className="flex gap-2">
                  {(['COMPANY', 'OWNER_OPERATOR'] as DriverType[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setClassification(c)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                        classification === c
                          ? 'border-sky-300 bg-sky-50 text-sky-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
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

              <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-slate-700">Internal only</div>
                  <div className="text-xs text-slate-500">Generate the checklist without sending a portal invite (backfill).</div>
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
                <LinkIcon size={16} /> Invite ready to send to {email}
              </DialogTitle>
              <DialogDescription>
                Email sending is wired up in Phase 3 (currently paused). For now, copy this link and send it
                to the driver manually. It stays valid for 14 days.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <input
                readOnly
                value={portalUrl}
                className="flex-1 bg-transparent text-sm text-slate-700 outline-none"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={copyLink}>
                {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
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
