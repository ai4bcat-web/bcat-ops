/**
 * `/tms/carriers/remit` — Carriers › Remit e-mails.
 *
 * Remittance advice goes to the PAY TO, not to the carrier. The Pay to table lists every payee, factoring
 * companies and carriers paid directly, with ONE address each that every carrier paid to that name uses.
 * The Carriers table is read-only: it shows each carrier's pay-to and the address that resolves to, with a
 * link to edit the payee.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsInput, TmsListPage, TmsPage, TmsSegmentedTabs, type ColumnDef } from '@/features/tms/kit'
import { useCarriers } from '@/hooks/useCarriers'
import { useAuth } from '@/hooks/useAuth'
import {
  getFactorRemitEmails, graphqlErrorText, listCarrierRemitEmails, setFactorRemitEmail,
} from '@/lib/apiClient'
import { applyFactorRemit, factorNameIndex, isRemitEmail, summarizeFactors, summarizePayees, type FactorRemitMap, type PayeeSummary } from '@/lib/factorRemit'
import {
  CARRIER_PAID_FILTERS, FACTOR_SOURCE_LABEL, FACTOR_STATUS_FILTERS, PAYEE_KIND_FILTERS, PAYEE_KIND_LABEL, carrierMatchesPaidFilter, carrierNeedsRemit, carrierRemitRows,
  factorNeedsRemit, matchesSearch,
  type CarrierPaidFilter, type CarrierRemitRow, type FactorStatusFilter, type PayeeKindFilter, type RemitMethod,
} from './remitDirectory'

type Kind = 'carriers' | 'factors'
const SELECT_STYLE = {
  height: 32, padding: '0 8px', background: 'var(--tms-field)', border: '1px solid var(--tms-input-border)',
  borderRadius: 'var(--tms-radius-sm)', color: 'var(--tms-text)', fontSize: 13,
} as const

/** The inline address editor: a field with Save and Cancel, Enter saves, Escape cancels. */
function EmailEditor({ initial, label, allowClear, onSave, onCancel }: {
  initial: string
  label: string
  allowClear?: boolean
  onSave: (email: string) => Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = value.trim()
  const valid = trimmed === '' ? allowClear === true && initial !== '' : isRemitEmail(trimmed) && trimmed !== initial

  async function save() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try { await onSave(trimmed) } catch (err) { setError(graphqlErrorText(err)); setBusy(false) }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <TmsInput
        aria-label={`Remit e-mail for ${label}`}
        type="email"
        value={value}
        autoFocus
        placeholder="ap@company.com"
        style={{ minWidth: 240 }}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // The grid around the field has its own keys; typing here is not for it.
          e.stopPropagation()
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <TmsButton size="sm" variant="primary" disabled={!valid || busy} onClick={() => void save()}>Save</TmsButton>
      <TmsButton size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</TmsButton>
      {error && <span className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</span>}
    </span>
  )
}

export function RemitDirectoryPage() {
  const { isAdmin, hasPageAccess } = useAuth()
  // The finance Lambda enforces this again; it only decides whether the Edit links are offered.
  const canEdit = isAdmin || hasPageAccess('carrierPay')
  const { carriers, loading, error: carriersError } = useCarriers()
  const [methods, setMethods] = useState<RemitMethod[] | null>(null)
  const [factorEmails, setFactorEmails] = useState<FactorRemitMap>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const [kind, setKind] = useState<Kind>('carriers')
  const [query, setQuery] = useState('')
  const [missingOnly, setMissingOnly] = useState(false)
  const [factorStatus, setFactorStatus] = useState<FactorStatusFilter>('ALL')
  const [payeeKind, setPayeeKind] = useState<PayeeKindFilter>('ALL')
  const [carrierPaid, setCarrierPaid] = useState<CarrierPaidFilter>('ALL')
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([listCarrierRemitEmails(), getFactorRemitEmails()])
      .then(([rows, map]) => { if (live) { setMethods(rows as RemitMethod[]); setFactorEmails(map); setLoadError(null) } })
      .catch(() => { if (live) setLoadError('Remit e-mails could not be loaded. Refresh to try again.') })
    return () => { live = false }
  }, [version])

  const reload = useCallback(() => { setEditing(null); setVersion((n) => n + 1) }, [])

  // The raw methods feed the factor summary (to see carriers that disagree); the laid-over ones feed the carrier rows.
  const effective = useMemo(() => (methods ? applyFactorRemit(methods, factorEmails) : []), [methods, factorEmails])
  // The Pay to table is the one source of a factor's name: the carrier rows spell it exactly as it is spelled here.
  const factorNames = useMemo(() => factorNameIndex(methods ? summarizeFactors(methods, factorEmails) : []), [methods, factorEmails])
  // Every payee, factoring companies and carriers paid directly, with the one address each is paid at.
  const payeeRows = useMemo(() => (methods ? summarizePayees(carriers, methods, factorEmails) : []), [carriers, methods, factorEmails])
  const carrierRows = useMemo(() => carrierRemitRows(carriers, effective, factorNames, factorEmails), [carriers, effective, factorNames, factorEmails])

  // Missing counts are payees, not carriers: a factor with no address is one gap however many carriers it funds.
  const missingPayees = payeeRows.filter(factorNeedsRemit).length

  const shownCarriers = useMemo(
    () => carrierRows.filter((r) => (!missingOnly || carrierNeedsRemit(r)) && carrierMatchesPaidFilter(r, carrierPaid) && matchesSearch(query, r.name, r.mcNumber, r.paidVia, r.email)),
    [carrierRows, missingOnly, carrierPaid, query],
  )
  const shownPayees = useMemo(
    () => payeeRows.filter((r) => (!missingOnly || factorNeedsRemit(r)) && (factorStatus === 'ALL' || r.source === factorStatus) && (payeeKind === 'ALL' || r.kind === payeeKind) && matchesSearch(query, r.name, r.email, ...r.otherNames, ...r.carrierNames)),
    [payeeRows, missingOnly, factorStatus, payeeKind, query],
  )

  function editPayee(name: string) {
    setKind('factors')
    setQuery(name)
    setMissingOnly(false)
    setFactorStatus('ALL')
    setPayeeKind('ALL')
    setEditing(null)
  }

  const carrierColumns: Array<ColumnDef<CarrierRemitRow>> = [
    {
      key: 'name', header: 'Carrier', width: 280,
      render: (r) => <Link className="tms-link" to={`/tms/carriers/${r.id}`}>{r.name}</Link>,
      text: (r) => r.name,
    },
    { key: 'mc', header: 'MC', width: 100, render: (r) => r.mcNumber || '—', text: (r) => r.mcNumber },
    {
      key: 'via', header: 'Pay to', width: 280,
      render: (r) => (r.paidVia === ''
        ? <span className="tms-muted">No payment info</span>
        : <span>{r.payTo}{r.paidVia === 'Direct' && <span className="tms-muted"> · direct</span>}</span>),
      text: (r) => r.payTo || 'No payment info',
    },
    {
      key: 'email', header: 'Remit e-mail (from the pay to)',
      render: (r) => {
        if (r.state === 'NO_PAYMENT_INFO') {
          return <Link className="tms-link" to={`/tms/carriers/${r.id}`}>Add payment info on the profile</Link>
        }
        // The address belongs to the pay to: it is read here and edited on the Pay to table.
        const link = canEdit && r.payTo
          ? <button type="button" className="tms-link whitespace-nowrap" onClick={() => editPayee(r.payTo)}>{r.email ? `Edit at ${r.payTo}` : `Add at ${r.payTo}`}</button>
          : null
        if (r.state === 'FACTOR' || r.state === 'OWN') {
          return <span title={`Filed once for ${r.payTo}; every carrier paid to that name uses it`}>{r.email} {link}</span>
        }
        return (
          <span className="inline-flex flex-wrap items-center gap-2">
            {r.state === 'INVALID' ? <TmsBadge tone="red">Invalid: {r.email}</TmsBadge> : <TmsBadge tone="orange">Missing</TmsBadge>}
            {r.carrierEmail && <span className="tms-muted" title="Used when the payment method has no remit e-mail">falls back to {r.carrierEmail}</span>}
            {link}
          </span>
        )
      },
      text: (r) => r.email || (r.state === 'NO_PAYMENT_INFO' ? 'No payment info' : 'Missing'),
    },
  ]

  const payeeColumns: Array<ColumnDef<PayeeSummary>> = [
    {
      key: 'name', header: 'Pay to', width: 320,
      render: (r) => (
        <span title={r.otherNames.length ? `Also spelled: ${r.otherNames.join('; ')}` : undefined}>
          {r.name}{r.otherNames.length > 0 && <span className="tms-muted"> +{r.otherNames.length} spelling{r.otherNames.length === 1 ? '' : 's'}</span>}
        </span>
      ),
      text: (r) => r.name,
    },
    {
      key: 'kind', header: 'Type', width: 150,
      render: (r) => <TmsBadge tone={r.kind === 'FACTOR' ? 'blue' : 'gray'}>{PAYEE_KIND_LABEL[r.kind]}</TmsBadge>,
      text: (r) => PAYEE_KIND_LABEL[r.kind],
      filter: 'multi',
    },
    {
      key: 'n', header: 'Carriers', width: 90, align: 'right',
      render: (r) => <span title={r.carrierNames.length ? r.carrierNames.join('; ') : undefined}>{r.carrierCount}</span>,
      text: (r) => String(r.carrierCount), sortValue: (r) => r.carrierCount, filter: 'number',
    },
    {
      key: 'email', header: 'Remit e-mail',
      render: (r) => {
        if (editing === `f:${r.key}`) {
          return (
            <EmailEditor
              initial={r.email}
              label={r.name}
              allowClear={r.source === 'SET'}
              onCancel={() => setEditing(null)}
              onSave={async (email) => {
                await setFactorRemitEmail({ payeeName: r.name, email })
                toast.success(email ? `Remit e-mail saved for every carrier paid to ${r.name}` : 'Remit e-mail cleared')
                reload()
              }}
            />
          )
        }
        return (
          <span className="inline-flex flex-wrap items-center gap-2">
            {r.email ? <span>{r.email}</span> : <span className="tms-muted">{r.source === 'CONFLICT' ? r.conflicting.join(', ') : 'None on file'}</span>}
            {canEdit && (
              <button type="button" className="tms-link whitespace-nowrap" onClick={() => setEditing(`f:${r.key}`)}>
                {r.email ? 'Edit' : r.source === 'CONFLICT' ? 'Pick one' : 'Add remit e-mail'}
              </button>
            )}
          </span>
        )
      },
      text: (r) => r.email || (r.source === 'CONFLICT' ? r.conflicting.join(', ') : 'None on file'),
    },
    {
      key: 'source', header: 'Status', width: 170,
      render: (r) => (
        <TmsBadge tone={r.source === 'SET' ? 'green' : r.source === 'CARRIERS' ? 'gray' : r.source === 'CONFLICT' ? 'orange' : 'red'}>
          {FACTOR_SOURCE_LABEL[r.source]}
        </TmsBadge>
      ),
      text: (r) => FACTOR_SOURCE_LABEL[r.source],
      filter: 'multi',
    },
  ]

  const busy = loading || methods === null
  const rows = kind === 'carriers' ? shownCarriers : shownPayees
  const total = kind === 'carriers' ? carrierRows.length : payeeRows.length

  return (
    <TmsPage title="Remit e-mails">
      <p className="tms-muted mb-3" style={{ maxWidth: 760 }}>
        Where remittance advice goes when a bill is paid. It goes to the Pay to, not to the carrier: each factoring company or direct payee
        has one address, shared by every carrier paid to that name.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TmsSegmentedTabs
          aria-label="Carriers or pay to"
          active={kind}
          onSelect={(k) => { setKind(k as Kind); setEditing(null) }}
          tabs={[
            { key: 'carriers', label: 'Carriers' },
            { key: 'factors', label: `Pay to${missingPayees ? ` · ${missingPayees} to fix` : ''}` },
          ]}
        />
        <TmsInput
          aria-label="Search remit e-mails"
          value={query}
          placeholder={kind === 'carriers' ? 'Search carrier, MC, pay to or e-mail' : 'Search pay to, carrier or e-mail'}
          style={{ minWidth: 300 }}
          onChange={(e) => setQuery(e.target.value)}
        />
        {kind === 'carriers' ? (
          <select aria-label="Filter carriers" style={SELECT_STYLE} value={carrierPaid} onChange={(e) => setCarrierPaid(e.target.value as CarrierPaidFilter)}>
            {CARRIER_PAID_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        ) : (
          <>
            <select aria-label="Filter by type" style={SELECT_STYLE} value={payeeKind} onChange={(e) => setPayeeKind(e.target.value as PayeeKindFilter)}>
              {PAYEE_KIND_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select aria-label="Filter by status" style={SELECT_STYLE} value={factorStatus} onChange={(e) => setFactorStatus(e.target.value as FactorStatusFilter)}>
              {FACTOR_STATUS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </>
        )}
        <label className="inline-flex items-center gap-1 text-sm">
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
          {kind === 'carriers' ? 'Missing remit e-mail only' : 'Missing or conflicting only'}
        </label>
        <span className="tms-muted" style={{ fontSize: 12 }}>{busy ? 'Loading…' : `${rows.length} of ${total}`}</span>
      </div>

      {(loadError || carriersError) && <p className="mb-2 text-sm" style={{ color: 'var(--tms-badge-red)' }}>{loadError ?? carriersError}</p>}

      {/* One list for both tables: click a header to sort, use its filter to narrow, the field picker to choose columns. */}
      {kind === 'carriers' ? (
        <TmsListPage
          embedded
          title="Carrier remit e-mails"
          gridId="remit-carriers"
          columns={carrierColumns}
          rows={shownCarriers}
          rowKey={(r) => r.id}
          emptyText={busy ? 'Loading…' : 'No carriers match.'}
          page={{ from: shownCarriers.length ? 1 : 0, to: shownCarriers.length, total: shownCarriers.length, pageSize: shownCarriers.length }}
        />
      ) : (
        <TmsListPage
          embedded
          title="Pay to remit e-mails"
          gridId="remit-payees"
          columns={payeeColumns}
          rows={shownPayees}
          rowKey={(r) => r.key}
          emptyText={busy ? 'Loading…' : 'No payees match.'}
          page={{ from: shownPayees.length ? 1 : 0, to: shownPayees.length, total: shownPayees.length, pageSize: shownPayees.length }}
        />
      )}
    </TmsPage>
  )
}
