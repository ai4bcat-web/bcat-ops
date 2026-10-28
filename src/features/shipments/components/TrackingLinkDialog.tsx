/**
 * The carrier ping link: a text with a URL the driver taps to share a location.
 *
 * The server answers with the URL whatever happened to the text, and this dialog says
 * plainly which it was. On dev Twilio is not configured at all, so `smsStatus` comes back
 * NOT_CONFIGURED — the link is real and copyable, and the dialog says it was not sent
 * rather than pretending a text went out.
 */
import { useState } from 'react'
import { AlertTriangle, Check, Copy, Send, StopCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { revokeTrackingLink, sendTrackingLink, type SendTrackingLinkResult } from '@/lib/apiClient'
import { MAX_SMS_BODY } from '@/lib/dispatch'
import { smsBodyFor } from '@/lib/trackingLink'
import { formatDateTime } from '@/lib/date'
import type { LoadCarrierRecord, TmsSettings, TrackingLinkRecord } from '@/types/tms'

/** A token-shaped stand-in, so the preview is the length the driver will actually get. */
const TOKEN_PLACEHOLDER = 'x'.repeat(32)

export function TrackingLinkDialog({
  loadCarrier, loadNumber, link, settings, brokerName, onClose, onChanged,
}: {
  loadCarrier: LoadCarrierRecord
  loadNumber: string
  /** The ACTIVE CARRIER_PING link, when one has already been sent. */
  link: TrackingLinkRecord | null
  settings: TmsSettings | null
  brokerName: string
  onClose: () => void
  /** Re-read the shipment: the send writes LoadCarrier and Load.trackingProvider too. */
  onChanged: () => void
}) {
  const [phone, setPhone] = useState(loadCarrier.driverPhone ?? '')
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<SendTrackingLinkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const url = result?.url ?? ''
  const previewUrl = url || `${window.location.origin}/track/l/${TOKEN_PLACEHOLDER}`
  const body = smsBodyFor(message.trim() || settings?.trackingSmsTemplate, {
    broker: brokerName,
    loadNumber,
    url: previewUrl,
  })

  const send = async (via: 'SMS' | 'COPY') => {
    setError(null)
    setBusy(true)
    try {
      const r = await sendTrackingLink({
        loadCarrierId: loadCarrier.id,
        to: via === 'SMS' ? (phone.trim() || null) : null,
        via,
        message: message.trim() || null,
      })
      setResult(r)
      onChanged()
      if (r.smsStatus === 'SENT') toast.success('Tracking link texted to the driver')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The tracking link could not be sent')
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!link) return
    setError(null)
    setBusy(true)
    try {
      await revokeTrackingLink({ trackingLinkId: link.id })
      onChanged()
      toast.success('Tracking stopped')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The link could not be revoked')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Send tracking link</DialogTitle></DialogHeader>

        {link && (
          <div className="space-y-1 rounded-lg border border-border p-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">{link.status}</Badge>
              <span className="text-xs text-muted-foreground">Expires {formatDateTime(link.expiresAt)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Sent {link.sentAt ? formatDateTime(link.sentAt) : 'not yet'}
              {' · '}opened {link.openCount ?? 0}×
              {' · '}last ping {link.lastPingAt ? formatDateTime(link.lastPingAt) : 'none'}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Driver phone</Label>
            <Input aria-label="Tracking link phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Message</Label>
            <Textarea
              aria-label="Tracking link message"
              rows={2}
              placeholder="Leave blank to use the house template"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="text-sm"
            />
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Text preview</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm" data-testid="sms-preview">{body}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">{body.length} / {MAX_SMS_BODY} characters</p>
          </div>
        </div>

        {result && (result.smsStatus === 'NOT_CONFIGURED' || result.smsStatus === 'FAILED') && (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
            {result.smsStatus === 'NOT_CONFIGURED'
              ? 'Texting is not configured on this environment, so nothing was sent. The link below is live — send it by hand.'
              : `The text did not send${result.smsError ? `: ${result.smsError}` : ''}. The link below is live — send it by hand.`}
          </p>
        )}
        {result && result.smsStatus === 'SENT' && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Check size={14} className="text-emerald-600" />Texted to {result.link.sentTo ?? phone}
          </p>
        )}
        {url && (
          <div className="flex items-center gap-2">
            <Input aria-label="Tracking link URL" readOnly value={url} className="h-9 text-xs" />
            <Button
              type="button" variant="outline" size="sm"
              onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Link copied') }}
            >
              <Copy size={14} className="mr-1" />Copy
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          {link && link.status === 'ACTIVE' && (
            <Button variant="outline" onClick={() => { void stop() }} disabled={busy} className="mr-auto">
              <StopCircle size={14} className="mr-1" />Stop tracking
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
          <Button variant="outline" onClick={() => { void send('COPY') }} disabled={busy}>
            <Copy size={14} className="mr-1" />Copy link
          </Button>
          <Button onClick={() => { void send('SMS') }} disabled={busy || !phone.trim()}>
            <Send size={14} className="mr-1" />{busy ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
