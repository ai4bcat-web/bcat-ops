/**
 * The customer tracking link: one stable URL per shipment, e-mailed to whoever asked
 * where the freight is.
 *
 * SES is denied on dev, so `emailStatus` comes back NOT_SENT and the dialog says so
 * instead of claiming a mail went out. The link itself is real either way, and what it
 * will show — carrier name, last position — is snapshotted when it is minted, so later
 * settings changes never widen a link already sent.
 */
import { useState } from 'react'
import { AlertTriangle, Check, Copy, RefreshCw, Send, Ban, Clock, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { revokeCustomerLink, sendCustomerLink, type SendCustomerLinkResult } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import type { CustomerRecord, ShipmentRecord, TmsSettings, TrackingLinkRecord } from '@/types/tms'

const EXPIRY_PRESETS = [
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '14 days', hours: 336 },
  { label: '30 days', hours: 720 },
  { label: 'Custom', hours: null },
] as const

/** Compute an expiry ISO string from preset hours or a custom date string. */
function expiryFromPreset(hours: number | null, customDate: string): string | null {
  if (hours != null) {
    const d = new Date(Date.now() + hours * 3600_000)
    return d.toISOString()
  }
  if (customDate) {
    const d = new Date(customDate + 'T23:59:59')
    return d.toISOString()
  }
  return null
}

/** Open a mailto URI pre-filled with the tracking link and shipment info. */
function mailtoUri(url: string, shipmentNumber: string): string {
  const subject = `Tracking for shipment ${shipmentNumber}`
  const body = `Here is a tracking link for shipment ${shipmentNumber}:\n\n${url}`
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/** Open an SMS URI pre-filled; works on macOS with Messages and some mobile browsers. */
function smsUri(url: string, shipmentNumber: string): string {
  return `sms:&body=${encodeURIComponent(`Tracking for shipment ${shipmentNumber}: ${url}`)}`
}

export function CustomerLinkDialog({
  shipment, customer, link, settings, onClose, onChanged,
}: {
  shipment: ShipmentRecord
  customer: CustomerRecord | null
  /** The ACTIVE CUSTOMER_VIEW link, when one has already been minted. */
  link: TrackingLinkRecord | null
  settings: TmsSettings | null
  onClose: () => void
  onChanged: () => void
}) {
  const contacts = (customer?.contacts ?? []).filter((c) => c.active && c.email)
  const [selected, setSelected] = useState<string[]>(() => {
    const first = contacts.find((c) => c.email)?.email ?? customer?.contactEmail ?? null
    // Pre-fill from existing link's sentTo (comma-joined) if re-sending
    if (!first && link?.sentTo) {
      return link.sentTo.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean)
    }
    return first ? [first] : []
  })
  const [extra, setExtra] = useState('')
  const [cc, setCc] = useState('')
  const [message, setMessage] = useState('')
  const [notes, setNotes] = useState(link?.notes ?? '')
  const [expiryPreset, setExpiryPreset] = useState<number | null>(() => {
    // Default 7 days
    return 168
  })
  const [customDate, setCustomDate] = useState('')
  // The CAS token, re-armed from the shipment the server hands back — never patched blind.
  const [version, setVersion] = useState(shipment.version ?? 0)
  const [result, setResult] = useState<SendCustomerLinkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const emails = [...selected, ...extra.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean)]
  const url = result?.url ?? link?.url ?? ''
  const contactPreview = settings?.trackingContact?.mode === 'FIXED'
    ? [settings.trackingContact.name, settings.trackingContact.email, settings.trackingContact.phone].filter(Boolean).join(' · ')
    : 'The rep on the shipment'

  const send = async (via: 'EMAIL' | 'COPY', regenerate = false) => {
    setError(null)
    if (via === 'EMAIL' && emails.length === 0) { setError('Pick at least one recipient.'); return }
    setBusy(true)
    try {
      const expiresAt = expiryFromPreset(expiryPreset, customDate) ?? undefined
      const r = await sendCustomerLink({
        shipmentId: shipment.id,
        expectedVersion: version,
        to: emails,
        cc: cc.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean),
        message: message.trim() || null,
        via,
        regenerate,
        ...(expiresAt ? { expiresAt } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      setResult(r)
      setVersion(r.shipment.version ?? version)
      onChanged()
      if (r.emailStatus === 'SENT') toast.success('Tracking link e-mailed')
      if (regenerate) toast.success('A new link was minted; the old one no longer works')
      if (via === 'COPY' && r.url) {
        try {
          await navigator.clipboard?.writeText(r.url)
          toast.success('Link copied to clipboard')
        } catch {
          // clipboard may be unavailable
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The customer link could not be sent')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!link) return
    setError(null)
    setBusy(true)
    try {
      await revokeCustomerLink({ trackingLinkId: link.id })
      onChanged()
      toast.success('Customer link revoked')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The link could not be revoked')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Customer tracking link"
      footer={
        <>
          {link && link.status === 'ACTIVE' && (
            <TmsButton onClick={() => { void revoke() }} disabled={busy} className="mr-auto">
              <Ban size={14} className="mr-1" />Revoke
            </TmsButton>
          )}
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Close</TmsButton>
          <TmsButton onClick={() => { void send('COPY', true) }} disabled={busy}>
            <RefreshCw size={14} className="mr-1" />Regenerate
          </TmsButton>
          <TmsButton onClick={() => { void send('COPY') }} disabled={busy}>
            <Copy size={14} className="mr-1" />Copy link
          </TmsButton>
          <TmsButton variant="primary" onClick={() => { void send('EMAIL') }} disabled={busy || emails.length === 0}>
            <Send size={14} className="mr-1" />{busy ? 'Sending…' : 'Send'}
          </TmsButton>
        </>
      }
    >
        <div data-testid="customer-link-dialog">
        {link && (
          <div className="space-y-1 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-3 text-sm">
            <div className="flex items-center gap-2">
              <TmsBadge tone="gray" className="text-[10px]">{link.status}</TmsBadge>
              <span className="text-xs tms-muted">Expires {formatDateTime(link.expiresAt)}</span>
            </div>
            <p className="text-xs tms-muted">
              Sent {link.sentAt ? formatDateTime(link.sentAt) : 'not yet'}
              {' · '}opened {link.openCount ?? 0}×
              {link.lastOpenedAt ? ` · last ${formatDateTime(link.lastOpenedAt)}` : ''}
            </p>
            <p className="text-xs tms-muted">
              Shows {link.showCarrier ? 'the carrier name' : 'no carrier'} · {link.showPosition ? 'the last position' : 'no position'}
            </p>
            {link.notes && <p className="text-xs tms-muted">Note: {link.notes}</p>}
          </div>
        )}

        <div>
          <Label className="tms-field-label flex items-center gap-2">
            <Clock size={14} /> Expiry
          </Label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {EXPIRY_PRESETS.map((preset) => (
              <TmsButton
                key={preset.label}
                size="sm"
                variant={expiryPreset === preset.hours ? 'primary' : 'secondary'}
                onClick={() => setExpiryPreset(preset.hours)}
              >
                {preset.label}
              </TmsButton>
            ))}
          </div>
          {expiryPreset == null && (
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              className="mt-2 h-9 w-full rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-input)] px-3 text-sm text-[color:var(--tms-text)]"
            />
          )}
          {customDate && expiryPreset == null && (
            <p className="mt-1 text-xs tms-muted">
              Expires at end of day {new Date(customDate + 'T23:59:59').toLocaleDateString()}
            </p>
          )}
        </div>

        <div>
          <Label className="tms-field-label">Notes (internal, not shown to customer)</Label>
          <TmsTextarea
            aria-label="Internal notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="text-sm"
            placeholder="e.g. Sent per Jane's request on call…"
          />
        </div>

        <div>
          <Label className="tms-field-label">Recipients</Label>
          <div className="mt-1.5 space-y-1.5">
            {contacts.length === 0 && (
              <p className="text-xs tms-muted">This customer has no contact with an e-mail on file — type one below.</p>
            )}
            {contacts.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label={`Send to ${c.email}`}
                  checked={selected.includes(c.email ?? '')}
                  onCheckedChange={(v) => setSelected((prev) => (
                    v === true ? [...prev, c.email ?? ''] : prev.filter((e) => e !== c.email)
                  ))}
                />
                {c.name} · {c.email}
              </label>
            ))}
          </div>
          <TmsInput
            aria-label="Other recipients"
            placeholder="other@customer.com, someone@else.com"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            className="mt-2 h-9 text-sm"
          />
        </div>

        <div>
          <Label className="tms-field-label">Cc</Label>
          <TmsInput aria-label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} className="h-9 text-sm" />
        </div>

        <div>
          <Label className="tms-field-label">Message to customer</Label>
          <TmsTextarea aria-label="Customer link message" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className="text-sm" />
        </div>

        <p className="text-xs tms-muted">The page tells them to contact: {contactPreview}</p>

        {result && result.emailStatus === 'NOT_SENT' && (
          <p className="flex items-start gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-card)] p-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--tms-badge-orange)]" />
            E-mail is not enabled on this environment, so nothing was sent
            {result.emailError ? ` (${result.emailError})` : ''}. The link below is live — send it by hand.
          </p>
        )}
        {result && result.emailStatus === 'SENT' && (
          <p className="flex items-center gap-2 text-xs tms-muted">
            <Check size={14} className="text-[color:var(--tms-badge-green)]" />Sent to {emails.join(', ')}
          </p>
        )}
        {url && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <TmsInput aria-label="Customer link URL" readOnly value={url} className="h-9 text-xs" />
              <TmsButton
                type="button" size="sm"
                onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Link copied') }}
              >
                <Copy size={14} className="mr-1" />Copy
              </TmsButton>
            </div>
            <div className="flex gap-2">
              <TmsButton
                size="sm" variant="secondary"
                onClick={() => window.open(mailtoUri(url, shipment.number), '_blank')}
              >
                <Send size={14} className="mr-1" />Open in e-mail
              </TmsButton>
              <TmsButton
                size="sm" variant="secondary"
                onClick={() => window.open(smsUri(url, shipment.number), '_blank')}
              >
                <MessageSquare size={14} className="mr-1" />Open in SMS
              </TmsButton>
            </div>
          </div>
        )}

        {error && <p className="text-xs text-[color:var(--tms-badge-red)]">{error}</p>}

        </div>
    </TmsDialog>
  )
}
