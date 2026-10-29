/**
 * One provider, one page — and one component for all of them.
 *
 * Everything here is read from the descriptor: the credential fields, the behaviour
 * settings, the capabilities, where the live action already lives and why a provider
 * cannot be live at all. Adding a provider to `src/lib/integrations/registry.ts` gives
 * it a finished page; nothing in this file names a provider except the handful of
 * extras in `providerExtras.tsx`, which exist because those providers genuinely need
 * one more control than the common pattern has.
 *
 * Two rules the page never bends. A stub says it is a stub, prints the provider it did
 * not call, and changes no shipment, invoice or factoring row. A credential leaves SSM
 * as four characters and nothing more — the fields below are write-only.
 */
import { useMemo, useState } from 'react'
import { ArrowLeft, Pencil } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
  TmsBadge, TmsButton, TmsCard, TmsDialog, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTable,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useIntegrations } from '@/hooks/useIntegrations'
import {
  connectIntegration, disconnectIntegration, runIntegrationStub, saveIntegrationSettings,
  validateIntegration,
} from '@/lib/apiClient'
import { badgeOf } from '@/lib/integrations/health'
import { credentialFieldsOf, liveCapabilitiesOf } from '@/lib/integrations/registry'
import { validateCredentials } from '@/lib/integrations/secrets'
import { defaultSettingsOf, validateProviderSettings } from '@/lib/integrations/settings'
import type {
  AdapterResult, Capability, IntegrationEvent, IntegrationRecord, ProviderDescriptor, SettingsField,
} from '@/lib/integrations/types'
import { formatDateTime } from '@/lib/date'
import { TRACKING_API_URL } from '@/lib/trackingClient'
import { LOADS_READ_SENTENCE, SOURCE_LABELS, categoryLabel, modeLabelOf } from './integrationView'
import { INTEGRATIONS_ROOT, descriptorForSlug } from './providerRoute'
import { ProviderExtras } from './providerExtras'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A provider nobody has connected yet still has a state: the badge says which. */
const UNSEEN: Pick<IntegrationRecord, 'status' | 'health' | 'mode'> = {
  status: 'NOT_CONNECTED',
  health: 'UNKNOWN',
  mode: 'STUB',
}

const CAPABILITY_LABELS: Record<Capability, string> = {
  connect: 'Connect',
  validate: 'Validate',
  post: 'Post a shipment',
  track: 'Track a shipment',
  quote: 'Quote a lane',
  factor: 'Factor an invoice',
  sync: 'Sync records',
}

interface CardProps {
  descriptor: ProviderDescriptor
  row: IntegrationRecord | undefined
  onChanged: () => Promise<void>
}

/**
 * The receiver a provider posts back to. It is a real endpoint — the signature and the
 * replay window below are what it actually enforces — and in this step it records the
 * delivery and nothing else.
 */
function WebhookRow({ descriptor, row }: { descriptor: ProviderDescriptor; row: IntegrationRecord | undefined }) {
  const base = TRACKING_API_URL || 'the tracking API Function URL'
  return (
    <div className="tms-field">
      <span className="tms-field-label">Webhook</span>
      <code>{`${base}/api/webhooks/${descriptor.key.toLowerCase()}`}</code>
      <span className="tms-field-hint">
        Signed with the webhook signing secret above: header <code>x-bcat-signature</code>, format{' '}
        <code>t=&lt;unix seconds&gt;,v1=&lt;HMAC-SHA256 of &quot;t.body&quot;&gt;</code>. A delivery more than five
        minutes old is refused as a replay.
      </span>
      <span className="tms-field-hint">
        {row?.lastWebhookAt
          ? `Last delivery received ${formatDateTime(row.lastWebhookAt)}${row.webhookCount ? ` · ${row.webhookCount} in total` : ''}.`
          : 'No delivery received yet.'}
      </span>
      <span className="tms-field-hint">
        Receipt is recorded here; acting on what arrives lands in Step K, so nothing is consumed yet.
      </span>
    </div>
  )
}

function CredentialsCard({ descriptor, row, onChanged }: CardProps) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const fields = credentialFieldsOf(descriptor)
  const source = descriptor.credentialSource
  const hasWebhook = fields.some((f) => f.key === 'webhookSigningSecret')

  const save = async () => {
    const entered: Record<string, string> = {}
    for (const field of fields) {
      const value = (values[field.key] ?? '').trim()
      if (value) entered[field.key] = value
    }
    // A re-entry may touch one field and leave the rest as they are; the router merges
    // what arrives with what is stored, so only a field that exists in neither place
    // is actually missing.
    const held = new Set((row?.credentialMask ?? []).map((m) => m.key))
    const found: string[] = fields
      .filter((f) => !f.optional && !entered[f.key] && !held.has(f.key))
      .map((f) => `${f.label} is required`)
    if (found.length === 0 && fields.every((f) => f.optional || entered[f.key])) {
      const checked = validateCredentials(descriptor, entered)
      if (!checked.ok) found.push(...checked.errors)
    }
    if (found.length > 0) {
      setErrors(found)
      return
    }
    setErrors([])
    setSaving(true)
    try {
      await connectIntegration(descriptor.key, entered)
      setValues({})
      setEditing(false)
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setSaving(false)
    }
  }

  const check = async () => {
    setErrors([])
    setValidating(true)
    try {
      await validateIntegration(descriptor.key)
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setValidating(false)
    }
  }

  const disconnect = async () => {
    setDisconnecting(true)
    try {
      await disconnectIntegration(descriptor.key)
      setConfirmOpen(false)
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setDisconnecting(false)
    }
  }

  const canValidate = descriptor.applicability === 'LIVE_CAPABLE'

  return (
    <TmsCard
      title="Credentials"
      actions={
        <>
          {source === 'PAGE' && !editing ? (
            <TmsButton size="sm" aria-label="Edit credentials" onClick={() => { setEditing(true); setErrors([]) }}>
              <Pencil size={14} aria-hidden="true" /> Edit
            </TmsButton>
          ) : null}
          {canValidate ? (
            <TmsButton size="sm" disabled={validating} onClick={() => void check()}>
              Validate
            </TmsButton>
          ) : null}
        </>
      }
    >
      {validating ? <TmsBadge tone="orange">Checking connection</TmsBadge> : null}

      <p className="tms-muted">Source: {SOURCE_LABELS[source] ?? source}</p>

      {source === 'PAGE' ? (
        <>
          <p className="tms-muted">
            Stored encrypted in AWS Systems Manager under this user pool. Nobody — including this page — can read a
            value back; only the last four characters ever leave it.
          </p>
          {editing ? (
            <>
              {fields.map((field) => {
                const last4 = row?.credentialMask?.find((m) => m.key === field.key)?.last4 ?? null
                return (
                  <TmsField
                    key={field.key}
                    label={field.optional ? `${field.label} (optional)` : field.label}
                    hint={field.hint}
                  >
                    <TmsInput
                      type={field.secret ? 'password' : field.kind === 'email' ? 'email' : 'text'}
                      autoComplete="off"
                      aria-label={field.label}
                      placeholder={last4 ? `•••• ${last4} — leave blank to keep` : 'Not set'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    />
                  </TmsField>
                )
              })}
              <div className="tms-page-actions">
                <TmsButton onClick={() => { setEditing(false); setValues({}); setErrors([]) }}>Cancel</TmsButton>
                <TmsButton variant="primary" disabled={saving} onClick={() => void save()}>
                  Save credentials
                </TmsButton>
              </div>
            </>
          ) : (
            <ul>
              {fields.map((field) => {
                const last4 = row?.credentialMask?.find((m) => m.key === field.key)?.last4 ?? null
                return (
                  <li key={field.key}>
                    {field.label}: {last4 ? <code>•••• {last4}</code> : <span className="tms-muted">not set</span>}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : null}

      {source === 'STACK' ? (
        <>
          <p className="tms-muted">
            Held by the stack as an Amplify secret. This page shows the names and checks them; it never reads or
            writes a value, because the deploy owns those paths.
          </p>
          <ul>
            {descriptor.stackSecretNames.map((name) => (
              <li key={name}>
                <code>{name}</code> — set with <code>npx ampx secret set {name}</code> in the Amplify console.
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {source === 'BRIDGE' ? (
        <>
          <p className="tms-muted">
            Inbound only: an Apps Script bridge posts to a Function URL with the shared intake secret, so there is
            nothing to enter here. Health is the last message that actually arrived.
          </p>
          <ul>
            {descriptor.managedBy ? <li>Bridge: <code>{descriptor.managedBy}</code></li> : null}
            {descriptor.stackSecretNames.map((name) => (
              <li key={name}>Function URL secret: <code>{name}</code></li>
            ))}
            <li>
              {row?.lastOkAt
                ? `Last message received ${formatDateTime(row.lastOkAt)}.`
                : 'No message received yet.'}
            </li>
          </ul>
        </>
      ) : null}

      {source === 'SCRIPT' ? (
        <>
          <p className="tms-muted">
            Configured outside this page and stored under this user pool&apos;s own parameter path. This page never
            reads or writes the value; it lists the provider so every integration is in one place.
          </p>
          <ul>
            {descriptor.managedBy ? <li>Owned by: <code>{descriptor.managedBy}</code></li> : null}
            {row?.credentialRef ? <li>Parameter path: <code>{row.credentialRef}</code></li> : null}
            {descriptor.liveLink ? (
              <li>
                Configure it on <Link to={descriptor.liveLink.to}>{descriptor.liveLink.label}</Link>.
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {source === 'OWN' ? (
        <p className="tms-muted">
          BCAT issues these credentials itself — there is nothing to obtain from a vendor. Clients are issued below.
        </p>
      ) : null}

      {source === 'NONE' ? (
        <p className="tms-muted">This provider needs no credential.</p>
      ) : null}

      {hasWebhook ? <WebhookRow descriptor={descriptor} row={row} /> : null}

      <p className="tms-muted">
        {row?.lastCheckAt ? `Last check ${formatDateTime(row.lastCheckAt)}` : 'Never checked'}
        {row?.healthDetail ? ` — ${row.healthDetail}` : ''}
      </p>
      <p className="tms-field-hint">
        {descriptor.validateHow.liveCheck
          ? `How it is checked: ${descriptor.validateHow.describe}`
          : `Not checked against the provider — ${descriptor.validateHow.describe}`}
      </p>

      {errors.map((text) => (
        <p className="tms-field-error" key={text}>{text}</p>
      ))}

      {source === 'PAGE' && row?.status === 'CONNECTED' ? (
        <div className="tms-page-actions">
          <TmsButton variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
            Disconnect
          </TmsButton>
        </div>
      ) : null}

      <TmsDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Disconnect ${descriptor.label}?`}
        footer={
          <>
            <TmsButton onClick={() => setConfirmOpen(false)}>Keep it</TmsButton>
            <TmsButton variant="destructive" disabled={disconnecting} onClick={() => void disconnect()}>
              Disconnect
            </TmsButton>
          </>
        }
      >
        <p>Deleted: the stored credential in Systems Manager, and the last-four masks shown above.</p>
        <p>
          Kept: this provider row, its behaviour settings, its check history and every audit entry. Reconnecting is
          re-entering the credential — nothing else is lost.
        </p>
      </TmsDialog>
    </TmsCard>
  )
}

function settingsControl(
  field: SettingsField,
  value: unknown,
  onChange: (next: unknown) => void,
) {
  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        className="tms-check"
        aria-label={field.label}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <TmsSelect
        aria-label={field.label}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        options={field.options ?? []}
        placeholder="—"
      />
    )
  }
  return (
    <TmsInput
      type={field.type === 'number' ? 'number' : 'text'}
      aria-label={field.label}
      min={field.min}
      max={field.max}
      step={field.step}
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(field.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
    />
  )
}

/**
 * The behaviour card is editable whatever the credential says: how a provider should
 * act once it is live is a decision that can be made before the key arrives.
 */
function BehaviourCard({ descriptor, row, onChanged }: CardProps) {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const stored = useMemo(
    () => ({ ...defaultSettingsOf(descriptor), ...(row?.settings ?? {}) }),
    [descriptor, row?.settings],
  )
  const settings = draft ?? stored

  const save = async () => {
    const checked = validateProviderSettings(descriptor, settings)
    if (!checked.ok) {
      setErrors(checked.errors)
      return
    }
    setErrors([])
    setSaving(true)
    try {
      await saveIntegrationSettings(descriptor.key, checked.value, row?.version ?? undefined)
      setDraft(null)
      setSaved(true)
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setSaving(false)
    }
  }

  return (
    <TmsCard title="Behaviour">
      {/* A `json` setting belongs to a provider extra's own card; there is no sensible
          control for an opaque object here, and a blank text box would invite one. */}
      {descriptor.settingsFields.filter((field) => field.type !== 'json').map((field) => (
        <TmsField key={field.key} label={field.label} hint={field.hint}>
          {settingsControl(field, settings[field.key], (next) => {
            setSaved(false)
            setDraft({ ...settings, [field.key]: next })
          })}
        </TmsField>
      ))}
      {errors.map((text) => (
        <p className="tms-field-error" key={text}>{text}</p>
      ))}
      <div className="tms-page-actions">
        {saved ? <TmsBadge tone="green">Saved</TmsBadge> : null}
        <TmsButton variant="primary" disabled={saving} onClick={() => void save()}>
          Save behaviour
        </TmsButton>
      </div>
    </TmsCard>
  )
}

function FeedsCard({ descriptor, row, onChanged }: CardProps) {
  const [results, setResults] = useState<Record<string, AdapterResult>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  // What is live is what this repo actually implements — never what a stored credential
  // suggests. Everything else offers a stub, because a capability nothing can run must
  // not be dressed up as one that merely runs elsewhere.
  const implemented = liveCapabilitiesOf(descriptor)
  const connected = row?.status === 'CONNECTED' && row.health === 'OK'

  const run = async (capability: Capability) => {
    setErrors([])
    setBusy(capability)
    try {
      const { result } = await runIntegrationStub(descriptor.key, capability)
      setResults((prev) => ({ ...prev, [capability]: result }))
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setBusy(null)
    }
  }

  return (
    <TmsCard title="What this feeds">
      <p>{descriptor.feeds}</p>
      <p className="tms-muted">{LOADS_READ_SENTENCE[descriptor.loadsRead]}</p>
      {descriptor.applicability === 'NOT_APPLICABLE' ? (
        <p className="tms-muted">
          Nothing runs here, live or stubbed: {descriptor.notApplicableReason}
        </p>
      ) : (
        <ul>
          {descriptor.capabilities.map((capability) => {
            const result = results[capability]
            return (
              <li key={capability}>
                <strong>{CAPABILITY_LABELS[capability] ?? capability}</strong>
                {implemented.includes(capability) && connected ? (
                  capability === 'validate' ? (
                    <> — live, and the Validate button above runs it.</>
                  ) : descriptor.liveLink ? (
                    <> — live, and it runs from <Link to={descriptor.liveLink.to}>{descriptor.liveLink.label}</Link>.</>
                  ) : (
                    <> — live, and it runs on its own schedule in the stack; there is nothing to start here.</>
                  )
                ) : (
                  <>
                    {' '}
                    <TmsButton
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void run(capability)}
                    >
                      Run stub
                    </TmsButton>
                  </>
                )}
                {result ? (
                  <div>
                    <TmsBadge tone="orange">Stub</TmsBadge> {result.message}
                    <p className="tms-muted">No call was made to {descriptor.label}.</p>
                    {result.externalId ? <p className="tms-field-hint">Reference: <code>{result.externalId}</code></p> : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {errors.map((text) => (
        <p className="tms-field-error" key={text}>{text}</p>
      ))}
    </TmsCard>
  )
}

const EVENT_COLUMNS: ColumnDef<IntegrationEvent>[] = [
  { key: 'at', header: 'WHEN', width: 170, render: (e) => formatDateTime(e.at) },
  { key: 'action', header: 'ACTION', width: 160, render: (e) => e.action },
  { key: 'by', header: 'BY', width: 200, render: (e) => e.by },
  { key: 'outcome', header: 'OUTCOME', width: 160, render: (e) => e.outcome },
  { key: 'detail', header: 'DETAIL', render: (e) => e.detail ?? '—' },
]

export function IntegrationPage() {
  const { provider } = useParams<{ provider: string }>()
  const descriptor = useMemo(() => descriptorForSlug(provider), [provider])
  const { rows, byKey, error, refresh } = useIntegrations()

  const back = (
    <p>
      <Link to={INTEGRATIONS_ROOT}>
        <ArrowLeft size={14} aria-hidden="true" /> Back to integrations
      </Link>
    </p>
  )

  if (!descriptor) {
    return (
      <div className="tms-page">
        {back}
        <TmsCard title="Unknown provider">
          <p>
            No provider is registered under <code>{provider}</code>. The list has everything the brokerage can
            connect to.
          </p>
        </TmsCard>
      </div>
    )
  }

  const row = byKey[descriptor.key]
  const badge = badgeOf({ ...UNSEEN, ...row, applicability: descriptor.applicability })
  const mode = modeLabelOf(descriptor, row)
  const events = row?.events ?? []
  const notApplicable = descriptor.applicability === 'NOT_APPLICABLE'

  return (
    <div className="tms-page">
      {back}
      {error ? <p className="tms-field-error">{error}</p> : null}

      <TmsCard title={descriptor.label}>
        <p>
          <TmsBadge tone={badge.tone}>{badge.label}</TmsBadge> <TmsBadge tone="gray">{mode}</TmsBadge>{' '}
          <span className="tms-muted">{categoryLabel(descriptor.category)}</span>
        </p>
        <p>{descriptor.feeds}</p>
        <p className="tms-muted">{LOADS_READ_SENTENCE[descriptor.loadsRead]}</p>
        {descriptor.note ? <p className="tms-muted">{descriptor.note}</p> : null}
        {descriptor.docsUrl ? (
          <p>
            <a href={descriptor.docsUrl} target="_blank" rel="noreferrer">Provider documentation</a>
          </p>
        ) : null}
      </TmsCard>

      {notApplicable ? (
        <TmsCard title="Not applicable">
          <p>{descriptor.notApplicableReason}</p>
          <p className="tms-muted">
            There is no credential form on this page because there is no connection to make. The row is kept so the
            decision is written down where somebody would look for it.
          </p>
        </TmsCard>
      ) : (
        <CredentialsCard descriptor={descriptor} row={row} onChanged={refresh} />
      )}

      {descriptor.settingsFields.some((field) => field.type !== 'json') ? (
        <BehaviourCard descriptor={descriptor} row={row} onChanged={refresh} />
      ) : null}

      <FeedsCard descriptor={descriptor} row={row} onChanged={refresh} />

      <ProviderExtras descriptor={descriptor} row={row} rows={rows} onChanged={refresh} />

      <TmsCard title="Events" flush>
        <TmsTable
          columns={EVENT_COLUMNS}
          rows={events}
          rowKey={(e) => `${e.at}-${e.action}`}
          empty={<TmsEmptyState title="No checks yet" message="Validate runs the first one." />}
        />
      </TmsCard>
    </div>
  )
}

export default IntegrationPage
