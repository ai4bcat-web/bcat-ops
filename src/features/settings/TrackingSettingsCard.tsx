import { useEffect, useState } from 'react'
import { Radar, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveTrackingSettings } from '@/lib/apiClient'
import {
  DEFAULT_CHECK_CALL_GRACE_MINUTES, DEFAULT_CHECK_CALL_INTERVAL_HOURS,
} from '@/lib/checkCalls'
import {
  DEFAULT_CUSTOMER_LINK_EXPIRY_DAYS, DEFAULT_TRACKING_LINK_EXPIRY_HOURS, DEFAULT_TRACKING_SMS_TEMPLATE,
} from '@/lib/trackingLink'
import type { CheckCallNotifyChannel, TmsSettings, TrackingContact } from '@/types/tms'
import { CheckRow, ErrorText, GroupLabel, Hint, Loading, SettingsCard, Stack } from './settingsKit'

/**
 * Step J's org-level tracking defaults. They are stored and shown only: nothing in the
 * app reads them until a tracking provider is live, and every control here says so.
 */
const DEFAULT_TRACK_BY_DEFAULT = true
const DEFAULT_TRACKING_INTERVAL_MIN = 30
const DEFAULT_TRACKING_DURATION_HOURS = 72
const PROVIDER_NOTE = 'Stored now, used once a tracking provider is live.'

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
  const [trackByDefault, setTrackByDefault] = useState(DEFAULT_TRACK_BY_DEFAULT)
  const [autoStatusFromGeofence, setAutoStatusFromGeofence] = useState(false)
  const [trackingIntervalMin, setTrackingIntervalMin] = useState('')
  const [trackingDurationHours, setTrackingDurationHours] = useState('')
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
        // Unset means the house default, which is to ask a provider to track.
        setTrackByDefault(s?.trackByDefault !== false)
        setAutoStatusFromGeofence(s?.autoStatusFromGeofence === true)
        setTrackingIntervalMin(s?.trackingIntervalMin != null ? String(s.trackingIntervalMin) : '')
        setTrackingDurationHours(s?.trackingDurationHours != null ? String(s.trackingDurationHours) : '')
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
        trackByDefault,
        autoStatusFromGeofence,
        trackingIntervalMin: parseWhole(trackingIntervalMin, 'Tracking ping interval', 5, 240),
        trackingDurationHours: parseWhole(trackingDurationHours, 'Tracking duration', 1, 336),
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
    <SettingsCard
      icon={Radar}
      title="Tracking & check calls"
      description="How often a tracked load is called, when a missed call counts as overdue, how long a public link lives and what a customer is allowed to see. Leave a box blank to use the house default."
    >
      {loading ? <Loading /> : (
        <Stack>
          <div className="tms-grid tms-grid-4">
            <TmsField label="Check call every (hours)">
              <TmsInput
                aria-label="Check call interval hours"
                value={intervalHours}
                onChange={(e) => setIntervalHours(e.target.value)}
                placeholder={String(DEFAULT_CHECK_CALL_INTERVAL_HOURS)}
              />
            </TmsField>
            <TmsField label="Grace (minutes)">
              <TmsInput
                aria-label="Check call grace minutes"
                value={graceMinutes}
                onChange={(e) => setGraceMinutes(e.target.value)}
                placeholder={String(DEFAULT_CHECK_CALL_GRACE_MINUTES)}
              />
            </TmsField>
            <TmsField label="Carrier link expiry (hours)">
              <TmsInput
                aria-label="Tracking link expiry hours"
                value={linkExpiryHours}
                onChange={(e) => setLinkExpiryHours(e.target.value)}
                placeholder={String(DEFAULT_TRACKING_LINK_EXPIRY_HOURS)}
              />
            </TmsField>
            <TmsField label="Customer link expiry (days)">
              <TmsInput
                aria-label="Customer link expiry days"
                value={customerLinkDays}
                onChange={(e) => setCustomerLinkDays(e.target.value)}
                placeholder={String(DEFAULT_CUSTOMER_LINK_EXPIRY_DAYS)}
              />
            </TmsField>
          </div>

          <div className="tms-grid tms-grid-2">
            <TmsField label="Who hears about a due check call">
              <TmsSelect
                aria-label="Check call notify channel"
                value={notifyChannel}
                onChange={(e) => setNotifyChannel(e.target.value as CheckCallNotifyChannel)}
              >
                {NOTIFY_CHANNELS.map((c) => <option key={c} value={c}>{NOTIFY_LABELS[c]}</option>)}
              </TmsSelect>
            </TmsField>
            <TmsField label="Slack channel id">
              <TmsInput
                aria-label="Check call Slack channel"
                value={slackChannelId}
                onChange={(e) => setSlackChannelId(e.target.value)}
                placeholder="C01234567"
              />
            </TmsField>
          </div>

          <Stack gap={8}>
            <CheckRow
              ariaLabel="Customer link shows the carrier"
              label="The customer tracking page names the carrier"
              checked={showsCarrier}
              onChange={setShowsCarrier}
            />
            <CheckRow
              ariaLabel="Customer link shows the position"
              label="The customer tracking page shows the last known position"
              checked={showsPosition}
              onChange={setShowsPosition}
            />
            <Hint>Each link keeps whatever these said when it was minted, so turning one off never widens or narrows a link already sent.</Hint>
          </Stack>

          <Stack gap={8}>
            <GroupLabel>Shared tracking defaults</GroupLabel>
            <CheckRow
              ariaLabel="Track every shipment by default"
              label={`Ask the tracking provider to track every shipment by default — ${PROVIDER_NOTE.toLowerCase()}`}
              checked={trackByDefault}
              onChange={setTrackByDefault}
            />
            <CheckRow
              ariaLabel="Set status from geofence"
              label={`Move the load status automatically when a geofence is crossed — ${PROVIDER_NOTE.toLowerCase()}`}
              checked={autoStatusFromGeofence}
              onChange={setAutoStatusFromGeofence}
            />
            <div className="tms-grid tms-grid-2">
              <TmsField label="Ping interval (minutes)" hint={PROVIDER_NOTE}>
                <TmsInput
                  aria-label="Tracking ping interval minutes"
                  value={trackingIntervalMin}
                  onChange={(e) => setTrackingIntervalMin(e.target.value)}
                  placeholder={String(DEFAULT_TRACKING_INTERVAL_MIN)}
                />
              </TmsField>
              <TmsField label="Track for (hours)" hint={PROVIDER_NOTE}>
                <TmsInput
                  aria-label="Tracking duration hours"
                  value={trackingDurationHours}
                  onChange={(e) => setTrackingDurationHours(e.target.value)}
                  placeholder={String(DEFAULT_TRACKING_DURATION_HOURS)}
                />
              </TmsField>
            </div>
            <Hint>{PROVIDER_NOTE} No carrier tracking provider is connected yet, so nothing in BCAT reads these four settings — they are kept here so the connection has them the day it is made.</Hint>
          </Stack>

          <Stack gap={8}>
            <TmsField label="Who the customer page says to call">
              <TmsSelect
                aria-label="Tracking contact mode"
                value={contactMode}
                onChange={(e) => setContactMode(e.target.value as TrackingContact['mode'])}
              >
                <option value="CUSTOMER_REP">The rep on the shipment</option>
                <option value="FIXED">One fixed desk</option>
              </TmsSelect>
            </TmsField>
            {contactMode === 'FIXED' && (
              <div className="tms-grid tms-grid-3">
                <TmsInput aria-label="Tracking contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Name" />
                <TmsInput aria-label="Tracking contact email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="E-mail" />
                <TmsInput aria-label="Tracking contact phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone" />
              </div>
            )}
          </Stack>

          <TmsField
            label="Carrier text template"
            hint={<>{'{broker}'}, {'{loadNumber}'} and {'{url}'} are filled in. {'{url}'} is required.</>}
          >
            <TmsTextarea
              aria-label="Tracking SMS template"
              rows={2}
              value={smsTemplate}
              onChange={(e) => setSmsTemplate(e.target.value)}
              placeholder={DEFAULT_TRACKING_SMS_TEMPLATE}
            />
          </TmsField>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save tracking settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
