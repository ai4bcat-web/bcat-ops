/**
 * The automation policy form — may we send on our own, to whom, when, with what words.
 * One component for the org default (GLOBAL), a division override and a customer
 * override. Below GLOBAL every field has an "Inherit" toggle: on means the key is absent
 * from the emitted patch and the control shows the value coming from the layers above.
 */
import { useRef, type ReactNode } from 'react'
import { TmsButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { TZ } from '@/lib/date'
import {
  AUTOMATION_CHANNELS,
  renderTemplate,
  sampleVars,
  TEMPLATE_KEYS,
  TEMPLATE_PLACEHOLDERS,
  templateProblem,
  type AutomationChannel,
  type AutomationPolicy,
  type AutomationPolicyPatch,
  type QuietHours,
  type TemplateKey,
} from '@/lib/trackingAutomation'
import { MAX_SMS_BODY } from '@/lib/dispatch'
import { CheckRow, ErrorText, GroupLabel, Hint, Panel } from '../settingsKit'
import {
  isSmsTemplate, smsCount, SMS_SEGMENT, withField, withTemplate, withoutField,
  type PolicyFieldKey,
} from './policyPatch'

export interface TrackingAutomationEditorProps {
  scope: 'GLOBAL' | 'DIVISION' | 'CUSTOMER'
  value: AutomationPolicyPatch
  /** Resolved from the layers above this scope: what "inherit" means here. */
  inherited: AutomationPolicy
  onChange: (next: AutomationPolicyPatch) => void
  disabled?: boolean
}

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  checkCallSms: 'Check call — text message',
  checkCallEmailSubject: 'Check call — e-mail subject',
  checkCallEmailBody: 'Check call — e-mail body',
  podSms: 'POD request — text message',
  podEmailSubject: 'POD request — e-mail subject',
  podEmailBody: 'POD request — e-mail body',
}

const CHANNEL_LABELS: Record<AutomationChannel, string> = { SMS: 'Text message', EMAIL: 'E-mail' }

const TIMEZONES: string[] = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC']

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

export function TrackingAutomationEditor({ scope, value, inherited, onChange, disabled }: TrackingAutomationEditorProps) {
  const inheritable = scope !== 'GLOBAL'
  const refs = useRef<Partial<Record<TemplateKey, HTMLTextAreaElement | null>>>({})

  const field = <K extends PolicyFieldKey>(key: K): AutomationPolicy[K] =>
    (value[key] ?? inherited[key]) as AutomationPolicy[K]
  const inheriting = (key: PolicyFieldKey) => inheritable && value[key] === undefined
  const setField = <K extends PolicyFieldKey>(key: K, next: AutomationPolicy[K]) =>
    onChange(withField(value, key, next))

  const header = (key: PolicyFieldKey, label: string): ReactNode => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <GroupLabel>{label}</GroupLabel>
      {inheritable && (
        <CheckRow
          checked={inheriting(key)}
          disabled={disabled}
          ariaLabel={`Inherit ${label}`}
          label="Inherit"
          onChange={(on) => onChange(on ? withoutField(value, key) : withField(value, key, inherited[key] as never))}
        />
      )}
    </div>
  )

  const quiet = field('quietHours')
  const setQuiet = (patch: Partial<QuietHours>) => setField('quietHours', { ...quiet, ...patch })
  const quietLocked = disabled || inheriting('quietHours')
  const zones = TIMEZONES.includes(quiet.timezone) ? TIMEZONES : [quiet.timezone, ...TIMEZONES]
  const vars = sampleVars()

  const insertAtCursor = (key: TemplateKey, name: string, current: string) => {
    const el = refs.current[key]
    const start = el?.selectionStart ?? current.length
    const end = el?.selectionEnd ?? current.length
    const token = `{${name}}`
    onChange(withTemplate(value, key, current.slice(0, start) + token + current.slice(end)))
    const caret = start + token.length
    setTimeout(() => { el?.focus(); el?.setSelectionRange(caret, caret) }, 0)
  }

  return (
    <div style={{ display: 'grid', gap: 12 }} data-testid={`automation-editor-${scope.toLowerCase()}`}>
      <Panel>
        {header('checkCallsAuto', 'Automatic check calls')}
        <CheckRow
          checked={field('checkCallsAuto')}
          disabled={disabled || inheriting('checkCallsAuto')}
          onChange={(on) => setField('checkCallsAuto', on)}
          label="Send check calls on the plan's schedule without anyone clicking"
        />
        <Hint>Off by default. A manual “Request check call” always works.</Hint>
      </Panel>

      <Panel>
        {header('podAuto', 'Request the POD automatically')}
        <CheckRow
          checked={field('podAuto')}
          disabled={disabled || inheriting('podAuto')}
          onChange={(on) => setField('podAuto', on)}
          label="Request the POD automatically once a load is Delivered"
        />
        <Hint>One request per leg and channel, however many times the automation runs.</Hint>
        <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
          {AUTOMATION_CHANNELS.map((channel) => (
            <CheckRow
              key={channel}
              checked={field('podChannels').includes(channel)}
              disabled={disabled || inheriting('podChannels')}
              ariaLabel={`POD channel ${channel}`}
              onChange={() => setField('podChannels', toggle(field('podChannels'), channel))}
              label={CHANNEL_LABELS[channel]}
            />
          ))}
          {inheritable && (
            <CheckRow
              checked={inheriting('podChannels')}
              disabled={disabled}
              ariaLabel="Inherit POD channels"
              label="Inherit channels"
              onChange={(on) => onChange(on ? withoutField(value, 'podChannels') : withField(value, 'podChannels', inherited.podChannels))}
            />
          )}
        </div>
      </Panel>

      <Panel>
        {header('quietHours', 'Quiet hours')}
        <CheckRow
          checked={quiet.enabled}
          disabled={quietLocked}
          onChange={(on) => setQuiet({ enabled: on })}
          label="Hold automatic messages during quiet hours"
        />
        <div className="tms-grid tms-grid-3" style={{ marginTop: 6 }}>
          <label className="tms-field">
            <span className="tms-field-label">From</span>
            <TmsInput type="time" aria-label="Quiet hours start" disabled={quietLocked || !quiet.enabled} value={quiet.start} onChange={(e) => setQuiet({ start: e.target.value })} />
          </label>
          <label className="tms-field">
            <span className="tms-field-label">Until</span>
            <TmsInput type="time" aria-label="Quiet hours end" disabled={quietLocked || !quiet.enabled} value={quiet.end} onChange={(e) => setQuiet({ end: e.target.value })} />
          </label>
          <label className="tms-field">
            <span className="tms-field-label">Time zone</span>
            <TmsSelect
              aria-label="Quiet hours time zone"
              disabled={quietLocked || !quiet.enabled}
              value={quiet.timezone || TZ}
              onChange={(e) => setQuiet({ timezone: e.target.value })}
              options={zones.map((z) => ({ value: z, label: z }))}
            />
          </label>
        </div>
        <Hint>An end time before the start time means the window runs past midnight.</Hint>
        <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
          <span className="tms-field-label" style={{ margin: 0 }}>Applies to</span>
          {AUTOMATION_CHANNELS.map((channel) => (
            <CheckRow
              key={channel}
              checked={quiet.channels.includes(channel)}
              disabled={quietLocked || !quiet.enabled}
              ariaLabel={`Quiet hours ${channel}`}
              onChange={() => setQuiet({ channels: toggle(quiet.channels, channel) })}
              label={CHANNEL_LABELS[channel]}
            />
          ))}
        </div>
      </Panel>

      <Panel>
        <GroupLabel>Message wording</GroupLabel>
        <Hint>
          Applies to check calls on the cadence and to POD requests. Empty uses the built-in wording.
          Click a placeholder to insert it at the cursor.
        </Hint>
        <div style={{ display: 'grid', gap: 14, marginTop: 8 }}>
          {TEMPLATE_KEYS.map((key) => {
            const own = value.templates?.[key]
            const locked = inheritable && own === undefined
            const text = own ?? inherited.templates[key]
            const problem = own === undefined ? null : templateProblem(own, key)
            const sms = isSmsTemplate(key) ? smsCount(text) : null
            return (
              <div key={key} style={{ display: 'grid', gap: 6 }} data-testid={`template-${key}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <label className="tms-field-label" htmlFor={`tpl-${scope}-${key}`} style={{ margin: 0 }}>{TEMPLATE_LABELS[key]}</label>
                  {inheritable && (
                    <CheckRow
                      checked={locked}
                      disabled={disabled}
                      ariaLabel={`Inherit ${TEMPLATE_LABELS[key]}`}
                      label="Inherit"
                      onChange={(on) => onChange(withTemplate(value, key, on ? undefined : inherited.templates[key]))}
                    />
                  )}
                </div>
                <TmsTextarea
                  id={`tpl-${scope}-${key}`}
                  ref={(el) => { refs.current[key] = el }}
                  rows={key.endsWith('Body') ? 5 : key.endsWith('Subject') ? 1 : 3}
                  disabled={disabled || locked}
                  placeholder="Built-in wording"
                  value={text}
                  onChange={(e) => onChange(withTemplate(value, key, e.target.value))}
                />
                {!(disabled || locked) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {TEMPLATE_PLACEHOLDERS.map((name) => (
                      <TmsButton key={name} size="sm" variant="ghost" onClick={() => insertAtCursor(key, name, text)}>
                        {`{${name}}`}
                      </TmsButton>
                    ))}
                  </div>
                )}
                {sms && text.length > 0 && (
                  <p className={sms.tooLong ? 'tms-field-error tms-flush' : 'tms-field-hint tms-flush'} data-testid={`sms-count-${key}`}>
                    {sms.length}/{MAX_SMS_BODY} characters · {sms.segments} {sms.segments === 1 ? 'segment' : 'segments'} of {SMS_SEGMENT}
                  </p>
                )}
                {problem && <ErrorText>{problem}</ErrorText>}
                <p className="tms-field-hint tms-flush" data-testid={`preview-${key}`}>
                  {text ? renderTemplate(text, vars) : 'Preview: the built-in wording is used.'}
                </p>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}
