import { useEffect, useState } from 'react'
import { Radar, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getTmsSettings, saveTrackingSettings } from '@/lib/apiClient'
import {
  DEFAULT_CHECK_CALL_GRACE_MINUTES, DEFAULT_CHECK_CALL_INTERVAL_HOURS,
} from '@/lib/checkCalls'
import {
  DEFAULT_CUSTOMER_LINK_EXPIRY_DAYS, DEFAULT_TRACKING_LINK_EXPIRY_HOURS, DEFAULT_TRACKING_SMS_TEMPLATE,
} from '@/lib/trackingLink'
import type { CheckCallNotifyChannel, TmsSettings, TrackingContact } from '@/types/tms'

const NOTIFY_CHANNELS: readonly CheckCallNotifyChannel[] = ['IN_APP', 'SLACK', 'BOTH']
const NOTIFY_LABELS: Record<CheckCallNotifyChannel, string> = {
  IN_APP: 'In the app only',
  SLACK: 'Slack only',
  BOTH: 'App and Slack',
}

/** Blank means "use the house default", so an empty box is not an error. */
function parseWhole(text: string, label: string, min: number, max: number): number | null {
  const raw = text.trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}`)
  return n
}

export function TrackingSettingsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [intervalHours, setIntervalHours] = useState('')
  const [graceMinutes, setGraceMinutes] = useState('')
  const [notifyChannel, setNotifyChannel] = useState<CheckCallNotifyChannel>('IN_APP')
  const [slackChannelId, setSlackChannelId] = useState('')
  const [linkExpiryHours, setLinkExpiryHours] = useState('')
  const [customerLinkDays, setCustomerLinkDays] = useState('')
  const [showsCarrier, setShowsCarrier] = useState(false)
  const [showsPosition, setShowsPosition] = useState(true)
  const [contactMode, setContactMode] = useState<TrackingContact['mode']>('CUSTOMER_REP')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [smsTemplate, setSmsTemplate] = useState('')
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        setIntervalHours(s?.checkCallDefaultIntervalHours != null ? String(s.checkCallDefaultIntervalHours) : '')
        setGraceMinutes(s?.checkCallGraceMinutes != null ? String(s.checkCallGraceMinutes) : '')
        setNotifyChannel(s?.checkCallNotifyChannel ?? 'IN_APP')
        setSlackChannelId(s?.checkCallSlackChannelId ?? '')
        setLinkExpiryHours(s?.trackingLinkExpiryHours != null ? String(s.trackingLinkExpiryHours) : '')
        setCustomerLinkDays(s?.customerLinkExpiryDays != null ? String(s.customerLinkExpiryDays) : '')
        setShowsCarrier(s?.customerLinkShowsCarrier === true)
        // The house default is to show the position; only an explicit false hides it.
        setShowsPosition(s?.customerLinkShowsPosition !== false)
        setContactMode(s?.trackingContact?.mode ?? 'CUSTOMER_REP')
        setContactName(s?.trackingContact?.name ?? '')
        setContactEmail(s?.trackingContact?.email ?? '')
        setContactPhone(s?.trackingContact?.phone ?? '')
        setSmsTemplate(s?.trackingSmsTemplate ?? '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setError(null)

    let patch: Parameters<typeof saveTrackingSettings>[0]
    try {
      const template = smsTemplate.trim()
      if (template && !template.includes('{url}')) {
        throw new Error('The text template must contain {url} — without it the driver gets no link')
      }
      patch = {
        checkCallDefaultIntervalHours: parseWhole(intervalHours, 'Check call interval', 1, 48),
        checkCallGraceMinutes: parseWhole(graceMinutes, 'Grace', 0, 240),
        checkCallNotifyChannel: notifyChannel,
        checkCallSlackChannelId: slackChannelId.trim() || null,
        trackingLinkExpiryHours: parseWhole(linkExpiryHours, 'Tracking link expiry', 1, 720),
        customerLinkExpiryDays: parseWhole(customerLinkDays, 'Customer link expiry', 1, 365),
        customerLinkShowsCarrier: showsCarrier,
        customerLinkShowsPosition: showsPosition,
        trackingContact: contactMode === 'FIXED'
          ? { mode: 'FIXED', name: contactName.trim() || null, email: contactEmail.trim() || null, phone: contactPhone.trim() || null }
          : { mode: 'CUSTOMER_REP' },
        trackingSmsTemplate: template || null,
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those settings are not valid')
      return
    }

    setSaving(true)
    try {
      const updated = await saveTrackingSettings(patch, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Tracking settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Radar size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Tracking &amp; check calls</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>How often a tracked load is called, when a missed call counts as overdue, how long a public link lives and what a customer is allowed to see. Leave a box blank to use the house default.</div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Check call every (hours)</Label>
              <Input
                aria-label="Check call interval hours"
                value={intervalHours}
                onChange={(e) => setIntervalHours(e.target.value)}
                placeholder={String(DEFAULT_CHECK_CALL_INTERVAL_HOURS)}
                className="h-9 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Grace (minutes)</Label>
              <Input
                aria-label="Check call grace minutes"
                value={graceMinutes}
                onChange={(e) => setGraceMinutes(e.target.value)}
                placeholder={String(DEFAULT_CHECK_CALL_GRACE_MINUTES)}
                className="h-9 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Carrier link expiry (hours)</Label>
              <Input
                aria-label="Tracking link expiry hours"
                value={linkExpiryHours}
                onChange={(e) => setLinkExpiryHours(e.target.value)}
                placeholder={String(DEFAULT_TRACKING_LINK_EXPIRY_HOURS)}
                className="h-9 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Customer link expiry (days)</Label>
              <Input
                aria-label="Customer link expiry days"
                value={customerLinkDays}
                onChange={(e) => setCustomerLinkDays(e.target.value)}
                placeholder={String(DEFAULT_CUSTOMER_LINK_EXPIRY_DAYS)}
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Who hears about a due check call</Label>
              <select
                aria-label="Check call notify channel"
                value={notifyChannel}
                onChange={(e) => setNotifyChannel(e.target.value as CheckCallNotifyChannel)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {NOTIFY_CHANNELS.map((c) => <option key={c} value={c}>{NOTIFY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Slack channel id</Label>
              <Input
                aria-label="Check call Slack channel"
                value={slackChannelId}
                onChange={(e) => setSlackChannelId(e.target.value)}
                placeholder="C01234567"
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="Customer link shows the carrier"
                checked={showsCarrier}
                onCheckedChange={(v) => setShowsCarrier(v === true)}
              />
              The customer tracking page names the carrier
            </label>
            <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="Customer link shows the position"
                checked={showsPosition}
                onCheckedChange={(v) => setShowsPosition(v === true)}
              />
              The customer tracking page shows the last known position
            </label>
            <p className="text-xs text-muted-foreground">Each link keeps whatever these said when it was minted, so turning one off never widens or narrows a link already sent.</p>
          </div>

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Who the customer page says to call</Label>
            <select
              aria-label="Tracking contact mode"
              value={contactMode}
              onChange={(e) => setContactMode(e.target.value as TrackingContact['mode'])}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="CUSTOMER_REP">The rep on the order</option>
              <option value="FIXED">One fixed desk</option>
            </select>
            {contactMode === 'FIXED' && (
              <div className="mt-2 grid grid-cols-3 gap-3">
                <Input aria-label="Tracking contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Name" className="h-9 text-sm" />
                <Input aria-label="Tracking contact email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="E-mail" className="h-9 text-sm" />
                <Input aria-label="Tracking contact phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone" className="h-9 text-sm" />
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Carrier text template</Label>
            <Textarea
              aria-label="Tracking SMS template"
              rows={2}
              value={smsTemplate}
              onChange={(e) => setSmsTemplate(e.target.value)}
              placeholder={DEFAULT_TRACKING_SMS_TEMPLATE}
              className="text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">{'{broker}'}, {'{loadNumber}'} and {'{url}'} are filled in. {'{url}'} is required.</p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save tracking settings
          </Button>
        </div>
      )}
    </div>
  )
}
