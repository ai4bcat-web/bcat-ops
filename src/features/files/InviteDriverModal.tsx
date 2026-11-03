import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, Check } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import {
  createOnboardingInvite, generateInviteToken, inviteExpiry, buildPortalUrl, writeComplianceAudit,
} from '@/lib/complianceClient'
import { DRIVER_FLEETS, DRIVER_FLEET_LABELS } from '@/lib/fleetGroups'
import { applicationFormFor, templateIdForFleet } from '@/lib/driverOnboarding'
import { classificationForFleet } from '@/lib/fileHub'
import { generateChecklist, generateTemplateChecklist, resolveOnboardingTemplate } from '@/lib/complianceClient'
import type { DriverFleet } from '@/types/equipment'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsInput } from '@/features/tms/kit/TmsInput'

/**
 * The only way a driver enters the system: you invite them to apply.
 *
 * Creating drivers by hand produced half-filled records nobody owned — a name and a
 * phone typed from memory, then no application, no checklist and no audit trail. Here
 * the driver record is a placeholder created by the invitation; their own application
 * fills in the real details.
 *
 * Fleet is asked for because it decides which application form they get and which
 * documents their file will require. Inviting without one produces a driver nobody can
 * classify afterwards.
 */
export function InviteDriverModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  const addDriver = useAppStore((s) => s.addDriver)
  const updateDriverRecord = useAppStore((s) => s.updateDriver)

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [fleetGroup, setFleetGroup] = useState<DriverFleet | ''>('')
  const [busy, setBusy] = useState(false)
  // Carried over from the onboarding wizard: create the file and checklist without
  // emailing anyone, for a driver who won't use a portal or whose paperwork you hold.
  const [internalOnly, setInternalOnly] = useState(false)
  const [portalUrl, setPortalUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  // Internal-only still wants an email on the record for later, but won't send.
  const ready = emailOk && !!fleetGroup

  const invite = async () => {
    if (!ready) return
    setBusy(true)
    try {
      // The record is a stub until their application lands — named from the email so the
      // row is recognisable in the meantime, rather than blank.
      const placeholderName = name.trim() || email.trim().split('@')[0].replace(/[._-]+/g, ' ')
      const driver = await addDriver({
        name: placeholderName,
        phone: '',
        email: email.trim(),
        active: true,
        type: 'driver',
        fleetGroup: fleetGroup as DriverFleet,
        // Owner operators are also marked on driverType, which the dispatch board, the
        // settlement page and the rate-con text all read.
        ...(fleetGroup === 'OWNER_OPERATOR' ? { driverType: 'OWNER_OPERATOR' as const } : {}),
        onboardingStatus: internalOnly ? 'IN_PROGRESS' : 'INVITED',
      })

      // Generate the checklist as part of inviting. The old flow could create an invite
      // without one, leaving a driver in the portal with nothing to do.
      const classification = classificationForFleet(fleetGroup as DriverFleet)
      const templateId = templateIdForFleet(fleetGroup as DriverFleet)
      if (templateId) {
        const template = await resolveOnboardingTemplate(templateId)
        if (template) {
          await generateTemplateChecklist({ driverId: driver.id, driverType: classification, template })
          await updateDriverRecord(driver.id, { onboardingTemplateId: templateId })
        }
      } else {
        await generateChecklist({ entityType: 'DRIVER', entityId: driver.id, classification })
      }

      let url: string | null = null
      if (!internalOnly) {
        const token = generateInviteToken()
        await createOnboardingInvite({
          driverId: driver.id,
          email: email.trim(),
          driverType: classification,
          token,
          status: 'SENT',
          expiresAt: inviteExpiry(),
          sentAt: new Date().toISOString(),
        })
        url = buildPortalUrl(token)
      }

      await writeComplianceAudit({
        entityType: 'DRIVER', entityId: driver.id, action: 'onboarding_started',
        user: user?.email ?? 'unknown',
        changes: {
          invitedEmail: email.trim(), fleetGroup, internalOnly,
          template: templateId ?? 'standard',
          form: applicationFormFor(fleetGroup as DriverFleet)?.key,
        },
      })

      if (url) { setPortalUrl(url); toast.success(`Invitation created for ${email.trim()}`) }
      else { toast.success(`${placeholderName} added — checklist ready, no email sent`); onClose() }
    } catch (err) {
      toast.error(`Couldn't invite: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally { setBusy(false) }
  }

  const copy = () => {
    if (!portalUrl) return
    void navigator.clipboard.writeText(portalUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const label: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase',
    letterSpacing: '0.05em', display: 'block', marginBottom: 5,
  }

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="Invite a driver to apply"
      description="They fill in their own details"
      footer={portalUrl ? (
        <TmsButton variant="primary" onClick={onClose}>Done</TmsButton>
      ) : (
        <>
          <TmsButton onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={invite} disabled={!ready || busy}
            title={!emailOk ? 'Enter a valid email' : !fleetGroup ? 'Choose a fleet' : 'Create the invitation'}>
            {busy ? 'Working…' : internalOnly ? 'Add driver' : 'Invite driver to apply'}
          </TmsButton>
        </>
      )}
    >
      {portalUrl ? (
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--tms-text)', marginBottom: 10 }}>
            Invitation created. Send them this link:
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)' }}>
            <span style={{ flex: 1, fontSize: 11.5, color: 'var(--tms-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)' }}>{portalUrl}</span>
            <button onClick={copy} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--tms-primary-ink)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', marginTop: 10 }}>
            They now appear under <b>Onboarding</b>, and their file fills in as they upload.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={label}>Email *</label>
            <TmsInput type="email" value={email} autoFocus
              onChange={(e) => setEmail(e.target.value)} placeholder="driver@example.com" />
          </div>
          <div>
            <label style={label}>Fleet *</label>
            <select className="tms-select" value={fleetGroup} onChange={(e) => setFleetGroup(e.target.value as DriverFleet | '')}>
              <option value="">Select a fleet…</option>
              {DRIVER_FLEETS.map((g) => <option key={g} value={g}>{DRIVER_FLEET_LABELS[g]}</option>)}
            </select>
            <div style={{ fontSize: 11, color: 'var(--tms-muted)', marginTop: 4 }}>
              Decides their application, their documents, and their onboarding flow
              {fleetGroup && (templateIdForFleet(fleetGroup as DriverFleet)
                ? ' — Amazon Relay, in phases.'
                : fleetGroup === 'OWNER_OPERATOR'
                  ? ' — the owner-operator checklist (lease, W-9, insurance).'
                  : ' — the standard checklist.')}
            </div>
          </div>
          <div>
            <label style={{ ...label, marginBottom: 0 }}>
              <input type="checkbox" checked={internalOnly} onChange={(e) => setInternalOnly(e.target.checked)}
                style={{ marginRight: 7, verticalAlign: '-2px' }} />
              Don't email them — we'll handle it
            </label>
            <div style={{ fontSize: 11, color: 'var(--tms-muted)', marginTop: 4 }}>
              Creates the file and checklist without sending a portal link.
            </div>
          </div>
          <div>
            <label style={label}>Name (optional)</label>
            <TmsInput value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Taken from their application if left blank" />
          </div>
        </div>
      )}
    </TmsDialog>
  )
}
