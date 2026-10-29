/**
 * The handful of providers that need one control the common pattern has no place for.
 *
 * Everything here is an addition to `IntegrationPage`, never a replacement: the header,
 * credentials, behaviour, capabilities and events cards are the same for these
 * providers as for every other one. A provider absent from the switch below gets no
 * extra card and loses nothing, which is what keeps adding a provider a registry edit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import {
  TmsBadge, TmsButton, TmsCard, TmsDialog, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTable,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useStaff } from '@/hooks/useStaff'
import {
  connectQuickBooks, getTmsSettings, issueApiClient, listCustomers, previewQboSync, revokeApiClient,
  saveIntegrationSettings, updateCustomer, updateUserProfile,
} from '@/lib/apiClient'
import { qboMappingsValid } from '@/lib/integrations/qboPayloads'
import type { QboMappings } from '@/lib/integrations/qboPayloads'
import { validateProviderSettings } from '@/lib/integrations/settings'
import type { IntegrationRecord, ProviderDescriptor } from '@/lib/integrations/types'
import type { ChargeCodeDef, CustomerRecord, UserProfileRecord } from '@/types/tms'
import { formatDateTime } from '@/lib/date'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface ExtrasProps {
  descriptor: ProviderDescriptor
  row: IntegrationRecord | undefined
  /** Every integration row, because the API clients are rows of their own. */
  rows: IntegrationRecord[]
  onChanged: () => Promise<void>
}

// ── QuickBooks Online ────────────────────────────────────────────────────────

const QBO_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2'
const QBO_SCOPE = 'com.intuit.quickbooks.accounting'
const QBO_NONCE_KEY = 'qbo-oauth-state'

const QBO_ACCOUNT_FIELDS: Array<{ key: keyof QboMappings; label: string; hint: string }> = [
  { key: 'arAccountRef', label: 'Accounts receivable', hint: 'QuickBooks account id an invoice posts to.' },
  { key: 'apAccountRef', label: 'Accounts payable', hint: 'QuickBooks account id a carrier bill posts to.' },
  { key: 'depositAccountRef', label: 'Deposit account', hint: 'Where a customer payment lands.' },
  { key: 'expenseAccountRef', label: 'Default expense account', hint: 'Used by a bill line with no charge-code item.' },
]

/** Sample records, so a preview can be read before a single real row is synced. */
const QBO_SAMPLES = {
  INVOICE: {
    number: 'INV-1001',
    invoiceDate: '2026-01-05',
    dueAt: '2026-02-04',
    customerId: 'sample-customer',
    customerName: 'Sample Customer LLC',
    lines: [{ code: 'LINE_HAUL', label: 'Line haul', amountCents: 250_000 }],
    totalCents: 250_000,
  },
  BILL: {
    id: 'sample-bill',
    carrierId: 'sample-carrier',
    carrierName: 'Sample Carrier Inc',
    billNumber: 'BILL-1001',
    billDate: '2026-01-06',
    dueAt: '2026-02-05',
    lines: [{ code: 'LINE_HAUL', label: 'Line haul', amountCents: 200_000 }],
    netCents: 200_000,
  },
  PAYMENT: {
    id: 'sample-payment',
    customerId: 'sample-customer',
    receivedAt: '2026-02-01',
    method: 'ACH',
    reference: 'wire 8841',
    amountCents: 250_000,
  },
} as const

type QboSampleKind = keyof typeof QBO_SAMPLES

function QuickBooksExtra({ descriptor, row, onChanged }: ExtrasProps) {
  const settings = (row?.settings ?? {}) as { mappings?: QboMappings }
  // Entered to build the redirect only. The exchange reads the stored client id from
  // the credentials parameter, so this is never written to the row.
  const [clientId, setClientId] = useState('')
  const [mappings, setMappings] = useState<QboMappings | null>(null)
  const [chargeCodes, setChargeCodes] = useState<ChargeCodeDef[]>([])
  const [kind, setKind] = useState<QboSampleKind>('INVOICE')
  const [payload, setPayload] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const current = mappings ?? settings.mappings ?? {}

  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setChargeCodes(s?.chargeCodes ?? []) })
      .catch(() => { if (alive) setChargeCodes([]) })
    return () => { alive = false }
  }, [])

  // Intuit sends the admin back to this very page with the authorization code. The
  // redirect is read once, during the first render, so the mismatch case is a rendered
  // fact rather than a state write hiding in an effect; only the exchange itself —
  // which is a network call — happens in one.
  const [callback] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const realmId = params.get('realmId')
    if (!code || !realmId) return null
    const matched = params.get('state') === sessionStorage.getItem(QBO_NONCE_KEY)
    sessionStorage.removeItem(QBO_NONCE_KEY)
    return { code, realmId, matched }
  })
  const exchanged = useRef(false)

  useEffect(() => {
    if (!callback?.matched || exchanged.current) return
    exchanged.current = true
    connectQuickBooks({
      code: callback.code,
      realmId: callback.realmId,
      redirectUri: `${window.location.origin}${window.location.pathname}`,
    })
      .then(() => onChanged())
      .catch((err: unknown) => { setErrors([messageOf(err)]) })
  }, [callback, onChanged])

  const connect = () => {
    const nonce = crypto.randomUUID()
    sessionStorage.setItem(QBO_NONCE_KEY, nonce)
    const redirectUri = `${window.location.origin}${window.location.pathname}`
    const url = new URL(QBO_AUTHORIZE)
    url.searchParams.set('client_id', clientId.trim())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', QBO_SCOPE)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', nonce)
    window.location.assign(url.toString())
  }

  const saveMappings = async () => {
    const used = chargeCodes.map((c) => c.code)
    const checked = qboMappingsValid(current, used)
    if (!checked.ok) {
      setErrors(checked.errors)
      return
    }
    // The row's settings are the declared behaviour fields plus this one opaque map;
    // the descriptor's validator is run here so an undeclared key cannot reach the
    // router and be refused there instead.
    const next = validateProviderSettings(descriptor, { ...(row?.settings ?? {}), mappings: current })
    if (!next.ok) {
      setErrors(next.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      await saveIntegrationSettings(descriptor.key, next.value, row?.version ?? undefined)
      setMappings(null)
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setBusy(false)
    }
  }

  const preview = async () => {
    setErrors([])
    setBusy(true)
    try {
      const result = await previewQboSync({ kind, record: { ...QBO_SAMPLES[kind] }, mappings: { ...current } })
      setPayload(JSON.stringify(result.payload, null, 2))
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TmsCard title="QuickBooks Online connection">
        <p className="tms-muted">
          Intuit asks for consent in its own window and sends the authorization code back to this page. The refresh
          token it returns is stored in Systems Manager and never reaches the browser.
        </p>
        {callback && !callback.matched ? (
          <p className="tms-field-error">
            That QuickBooks redirect did not match the request this browser started, so nothing was stored. Start the
            connection again from this page.
          </p>
        ) : null}
        <TmsField
          label="Intuit client id"
          hint="Not a secret — it travels in the redirect URL. Entered here only to start the redirect; the exchange uses the client id stored in the credentials card above, and this value is never saved."
        >
          <TmsInput
            aria-label="Intuit client id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </TmsField>
        <p className="tms-field-hint">
          Redirect URI to register with Intuit: <code>{`${window.location.origin}${window.location.pathname}`}</code>
        </p>
        <div className="tms-page-actions">
          <TmsButton variant="primary" disabled={clientId.trim() === ''} onClick={connect}>
            Connect to QuickBooks Online
          </TmsButton>
        </div>
        {row?.status === 'CONNECTED' ? (
          <p className="tms-muted">
            Customer and vendor links are not written yet — party linking arrives with live sync.
          </p>
        ) : null}
      </TmsCard>

      <TmsCard title="Account and charge-code mapping">
        {QBO_ACCOUNT_FIELDS.map((field) => (
          <TmsField key={String(field.key)} label={field.label} hint={field.hint}>
            <TmsInput
              aria-label={field.label}
              value={(current[field.key] as string | null | undefined) ?? ''}
              onChange={(e) => setMappings({ ...current, [field.key]: e.target.value })}
            />
          </TmsField>
        ))}
        {chargeCodes.length === 0 ? (
          <p className="tms-muted">No charge codes are configured yet, so there is nothing to map to an item.</p>
        ) : (
          chargeCodes.map((code) => (
            <TmsField key={code.code} label={`${code.label} (${code.code}) item`}>
              <TmsInput
                aria-label={`${code.code} item`}
                value={current.chargeCodeItems?.[code.code] ?? ''}
                onChange={(e) => setMappings({
                  ...current,
                  chargeCodeItems: { ...(current.chargeCodeItems ?? {}), [code.code]: e.target.value },
                })}
              />
            </TmsField>
          ))
        )}
        <div className="tms-page-actions">
          <TmsButton variant="primary" disabled={busy} onClick={() => void saveMappings()}>
            Save mapping
          </TmsButton>
        </div>
      </TmsCard>

      <TmsCard title="Preview sync">
        <p className="tms-muted">
          Builds the body a live sync would post and stops there. Nothing is sent to QuickBooks in this step.
        </p>
        <TmsField label="Record type">
          <TmsSelect
            aria-label="Record type"
            value={kind}
            onChange={(e) => setKind(e.target.value as QboSampleKind)}
            options={[
              { value: 'INVOICE', label: 'Invoice' },
              { value: 'BILL', label: 'Carrier bill' },
              { value: 'PAYMENT', label: 'Customer payment' },
            ]}
          />
        </TmsField>
        <div className="tms-page-actions">
          <TmsButton disabled={busy} onClick={() => void preview()}>Preview sync</TmsButton>
        </div>
        {payload ? (
          <>
            <TmsBadge tone="orange">Stub</TmsBadge>
            <p className="tms-muted">Nothing was sent to QuickBooks Online.</p>
            <pre>{payload}</pre>
          </>
        ) : null}
        {errors.map((text) => <p className="tms-field-error" key={text}>{text}</p>)}
      </TmsCard>
    </>
  )
}

// ── BCAT's own API ───────────────────────────────────────────────────────────

const API_SCOPES = ['READ']

/** A client row's id is `api:<clientId>`; the caller authenticates with the bare part. */
const clientIdOf = (row: IntegrationRecord): string => row.id.replace(/^api:/, '')

function OpenApiExtra({ rows, onChanged }: ExtrasProps) {
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<{ clientId: string; secret: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const clients = useMemo(() => rows.filter((r) => r.kind === 'API_CLIENT'), [rows])

  const issue = async () => {
    if (name.trim() === '') {
      setErrors(['Name the system this client is for.'])
      return
    }
    setErrors([])
    setBusy(true)
    try {
      const result = await issueApiClient(name.trim(), API_SCOPES)
      setIssued({ clientId: result.clientId, secret: result.secret })
      setName('')
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (clientId: string) => {
    setErrors([])
    try {
      await revokeApiClient(clientId)
      await onChanged()
    } catch (err) {
      setErrors([messageOf(err)])
    }
  }

  const columns: ColumnDef<IntegrationRecord>[] = [
    { key: 'name', header: 'NAME', width: 180, render: (r) => r.name ?? '—' },
    { key: 'id', header: 'CLIENT ID', width: 220, render: (r) => <code>{clientIdOf(r)}</code> },
    { key: 'scopes', header: 'SCOPES', width: 120, render: (r) => (r.scopes ?? []).join(', ') || '—' },
    { key: 'created', header: 'CREATED', width: 170, render: (r) => (r.createdAt ? formatDateTime(r.createdAt) : '—') },
    { key: 'used', header: 'LAST USED', width: 170, render: (r) => (r.lastUsedAt ? formatDateTime(r.lastUsedAt) : 'Never') },
    {
      key: 'status',
      header: 'STATUS',
      width: 120,
      render: (r) => (r.revokedAt
        ? <TmsBadge tone="red">Revoked</TmsBadge>
        : <TmsBadge tone="green">Active</TmsBadge>),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (r.revokedAt ? null : (
        <TmsButton size="sm" variant="destructive" onClick={() => void revoke(clientIdOf(r))}>Revoke</TmsButton>
      )),
    },
  ]

  return (
    <TmsCard
      title="API clients"
      actions={<TmsButton size="sm" onClick={() => { setIssued(null); setOpen(true) }}>Issue client</TmsButton>}
    >
      <p className="tms-muted">
        A client reads shipments by PRO number and nothing else. Only the hash of its secret is stored, so a lost
        secret is replaced by issuing a new client, never recovered.
      </p>
      <TmsTable
        columns={columns}
        rows={clients}
        rowKey={(r) => r.id}
        empty={<TmsEmptyState title="No API clients yet" message="Issue one for the system that needs to read shipments." />}
      />
      {errors.map((text) => <p className="tms-field-error" key={text}>{text}</p>)}

      <TmsDialog
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) { setIssued(null); setCopied(false) } }}
        title="Issue an API client"
        footer={
          issued ? (
            <TmsButton variant="primary" onClick={() => { setOpen(false); setIssued(null); setCopied(false) }}>
              I have stored it
            </TmsButton>
          ) : (
            <>
              <TmsButton onClick={() => setOpen(false)}>Cancel</TmsButton>
              <TmsButton variant="primary" disabled={busy} onClick={() => void issue()}>Issue</TmsButton>
            </>
          )
        }
      >
        {issued ? (
          <>
            <p>Client id: <code>{issued.clientId}</code></p>
            <p>Secret: <code>{issued.secret}</code></p>
            <TmsButton
              size="sm"
              onClick={() => { void navigator.clipboard?.writeText(issued.secret); setCopied(true) }}
            >
              <Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy secret'}
            </TmsButton>
            <p className="tms-field-error">
              This is the only time the secret is shown. It is stored as a hash and cannot be read back.
            </p>
          </>
        ) : (
          <>
            <TmsField label="Name" hint="The system this client is for, e.g. “Acme customer portal”.">
              <TmsInput aria-label="Client name" value={name} onChange={(e) => setName(e.target.value)} />
            </TmsField>
            <p className="tms-muted">Scope: {API_SCOPES.join(', ')} — read-only.</p>
            {errors.map((text) => <p className="tms-field-error" key={text}>{text}</p>)}
          </>
        )}
      </TmsDialog>
    </TmsCard>
  )
}

// ── DAT: the per-user service e-mails ────────────────────────────────────────

function DatEmailsExtra() {
  const { staff, refresh } = useStaff()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const save = async (person: UserProfileRecord) => {
    setErrors([])
    setSaving(person.id)
    try {
      await updateUserProfile(person.id, { datEmail: (edits[person.id] ?? '').trim() })
      setEdits((prev) => ({ ...prev, [person.id]: '' }))
      await refresh()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setSaving(null)
    }
  }

  return (
    <TmsCard title="DAT e-mail per user">
      <p className="tms-muted">
        DAT identifies a poster by their own account e-mail, so each rep carries theirs. A plus-addressed e-mail is
        refused by DAT, so it is refused here too.
      </p>
      {staff.length === 0 ? <p className="tms-muted">No staff rows yet.</p> : null}
      {staff.map((person) => (
        <div key={person.id}>
          <TmsField
            label={person.name ?? person.email}
            hint={person.datEmail ? `Set to ${person.datEmail}` : 'Not set'}
          >
            <TmsInput
              type="email"
              aria-label={`DAT e-mail for ${person.name ?? person.email}`}
              placeholder={person.datEmail ?? 'name@company.com'}
              value={edits[person.id] ?? ''}
              onChange={(e) => setEdits({ ...edits, [person.id]: e.target.value })}
            />
          </TmsField>
          <div className="tms-page-actions">
            <TmsButton
              size="sm"
              disabled={saving === person.id || !(edits[person.id] ?? '').trim()}
              onClick={() => void save(person)}
            >
              Save
            </TmsButton>
          </div>
        </div>
      ))}
      {errors.map((text) => <p className="tms-field-error" key={text}>{text}</p>)}
    </TmsCard>
  )
}

// ── EDI: the per-customer trading-partner ids ────────────────────────────────

type EdiSettings = NonNullable<CustomerRecord['ediSettings']>

function EdiExtra() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [drafts, setDrafts] = useState<Record<string, EdiSettings>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(() => listCustomers()
    .then((rows) => setCustomers(rows))
    .catch((err: unknown) => { setErrors([messageOf(err)]) }), [])

  useEffect(() => { void load() }, [load])

  const save = async (customer: CustomerRecord) => {
    const draft = drafts[customer.id] ?? (customer.ediSettings as EdiSettings | null) ?? {}
    setErrors([])
    setSaving(customer.id)
    try {
      // UPSERT_CUSTOMER rebuilds the record from what it is given, so a patch of one
      // field would blank the rest: the whole record goes back, with the EDI ids
      // replaced — exactly what the directory page sends when it saves a customer.
      const { id, createdAt, updatedAt, ...rest } = customer
      await updateCustomer(id, { ...rest, ediSettings: draft }, updatedAt)
      await load()
    } catch (err) {
      setErrors([messageOf(err)])
    } finally {
      setSaving(null)
    }
  }

  return (
    <TmsCard title="Trading partners">
      <p className="tms-muted">
        One ISA/GS pair per customer that trades EDI with us. Stored now; a 204 cannot arrive before Orderful has a
        partner set up on their side.
      </p>
      {customers.length === 0 ? <p className="tms-muted">No customers yet.</p> : null}
      {customers.map((customer) => {
        const draft = drafts[customer.id] ?? (customer.ediSettings as EdiSettings | null) ?? {}
        const patch = (next: EdiSettings) => setDrafts({ ...drafts, [customer.id]: { ...draft, ...next } })
        return (
          <div key={customer.id} className="tms-grid tms-grid-2">
            <TmsField label={`${customer.name} — ISA id`}>
              <TmsInput
                aria-label={`${customer.name} ISA id`}
                value={draft.isaId ?? ''}
                onChange={(e) => patch({ isaId: e.target.value })}
              />
            </TmsField>
            <TmsField label={`${customer.name} — GS id`}>
              <TmsInput
                aria-label={`${customer.name} GS id`}
                value={draft.gsId ?? ''}
                onChange={(e) => patch({ gsId: e.target.value })}
              />
            </TmsField>
            <div className="tms-page-actions">
              <TmsButton size="sm" disabled={saving === customer.id} onClick={() => void save(customer)}>Save</TmsButton>
            </div>
          </div>
        )
      })}
      {errors.map((text) => <p className="tms-field-error" key={text}>{text}</p>)}
    </TmsCard>
  )
}

// ── The short notices ────────────────────────────────────────────────────────

function ProvisionedNotice({ descriptor }: { descriptor: ProviderDescriptor }) {
  return (
    <TmsCard title="Provisioned by the vendor">
      <p>
        {descriptor.label} does not sell self-service API access. The credential arrives from their team once an
        account manager enables it, so there is nothing to generate here — ask them, then enter what they send.
      </p>
    </TmsCard>
  )
}

function ArtisPayExtra({ row }: ExtrasProps) {
  return (
    <TmsCard title="Buyer account">
      <TmsField
        label="Buyer account"
        hint={row?.status === 'CONNECTED'
          ? 'The account list arrives with live sync.'
          : 'Available after connect — ArtisPay returns the buyer accounts once the identity token is accepted.'}
      >
        <TmsSelect aria-label="Buyer account" disabled options={[]} placeholder="Available after connect" />
      </TmsField>
    </TmsCard>
  )
}

export function ProviderExtras(props: ExtrasProps) {
  switch (props.descriptor.key) {
    case 'QUICKBOOKS_ONLINE':
      return <QuickBooksExtra {...props} />
    case 'OPENAPI':
      return <OpenApiExtra {...props} />
    case 'DAT':
      return <DatEmailsExtra />
    case 'ORDERFUL':
      return <EdiExtra />
    case 'ARTISPAY':
      return <ArtisPayExtra {...props} />
    case 'HIGHWAY':
    case 'TRIUMPH':
      return <ProvisionedNotice descriptor={props.descriptor} />
    default:
      return null
  }
}

export default ProviderExtras
