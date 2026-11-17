/**
 * `/tms/carriers/remit` — Carriers › Remit e-mails.
 *
 * Two lists of where remittance advice goes: every carrier, and every factoring company. A factoring
 * company has ONE address that every carrier it funds inherits, so a carrier paid through a factor shows
 * that address read-only and is edited at the factor. A direct-paid carrier keeps its own.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsInput, TmsPage, TmsSegmentedTabs, TmsTable, type ColumnDef } from '@/features/tms/kit'
import { useCarriers } from '@/hooks/useCarriers'
import { useAuth } from '@/hooks/useAuth'
import {
  getFactorRemitEmails, graphqlErrorText, listCarrierRemitEmails, setFactorRemitEmail, setPayeeRemitEmail,
} from '@/lib/apiClient'
import { applyFactorRemit, isRemitEmail, summarizeFactors, type FactorRemitMap, type FactorSummary } from '@/lib/factorRemit'
import {
  FACTOR_SOURCE_LABEL, carrierNeedsRemit, carrierRemitRows, factorNeedsRemit, matchesSearch,
  type CarrierRemitRow, type RemitMethod,
} from './remitDirectory'

type Kind = 'carriers' | 'factors'
const PAGE_SIZE = 200

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
  const [limit, setLimit] = useState(PAGE_SIZE)
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
  const carrierRows = useMemo(() => carrierRemitRows(carriers, effective), [carriers, effective])
  const factorRows = useMemo(() => (methods ? summarizeFactors(methods, factorEmails) : []), [methods, factorEmails])

  const missingCarriers = carrierRows.filter(carrierNeedsRemit).length
  const missingFactors = factorRows.filter(factorNeedsRemit).length

  const shownCarriers = useMemo(
    () => carrierRows.filter((r) => (!missingOnly || carrierNeedsRemit(r)) && matchesSearch(query, r.name, r.mcNumber, r.paidVia, r.email)),
    [carrierRows, missingOnly, query],
  )
  const shownFactors = useMemo(
    () => factorRows.filter((r) => (!missingOnly || factorNeedsRemit(r)) && matchesSearch(query, r.name, r.email, ...r.otherNames)),
    [factorRows, missingOnly, query],
  )

  function editFactor(name: string) {
    setKind('factors')
    setQuery(name)
    setMissingOnly(false)
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
      key: 'via', header: 'Paid', width: 240,
      render: (r) => (r.paidVia === '' ? <span className="tms-muted">No payment info</span>
        : r.factorKey ? <span>via {r.paidVia}</span> : <span>Direct</span>),
      text: (r) => r.paidVia,
    },
    {
      key: 'email', header: 'Remit e-mail',
      render: (r) => {
        if (editing === `c:${r.id}`) {
          return (
            <EmailEditor
              initial={r.email}
              label={r.name}
              onCancel={() => setEditing(null)}
              onSave={async (email) => { await setPayeeRemitEmail({ carrierId: r.id, email }); toast.success('Remit e-mail saved'); reload() }}
            />
          )
        }
        if (r.state === 'NO_PAYMENT_INFO') {
          return <Link className="tms-link" to={`/tms/carriers/${r.id}`}>Add payment info on the profile</Link>
        }
        if (r.state === 'FACTOR') {
          return (
            <span title={`Set once for ${r.paidVia}; every carrier it funds uses it`}>
              {r.email}{' '}
              {canEdit && <button type="button" className="tms-link" onClick={() => editFactor(r.paidVia)}>Edit at {r.paidVia}</button>}
            </span>
          )
        }
        if (r.state === 'OWN') {
          return (
            <span>
              {r.email}{' '}
              {canEdit && <button type="button" className="tms-link" onClick={() => setEditing(`c:${r.id}`)}>Edit</button>}
            </span>
          )
        }
        // Missing or invalid. A factor-paid carrier is fixed at the factor.
        if (r.factorKey) {
          return canEdit
            ? <button type="button" className="tms-link" onClick={() => editFactor(r.paidVia)}>Add at {r.paidVia}</button>
            : <TmsBadge tone="orange">Missing</TmsBadge>
        }
        return (
          <span className="inline-flex items-center gap-2">
            <TmsBadge tone={r.state === 'INVALID' ? 'red' : 'orange'}>{r.state === 'INVALID' ? `Invalid: ${r.email}` : 'Missing'}</TmsBadge>
            {r.carrierEmail && <span className="tms-muted" title="Used when the payment method has no remit e-mail">falls back to {r.carrierEmail}</span>}
            {canEdit && <button type="button" className="tms-link whitespace-nowrap" onClick={() => setEditing(`c:${r.id}`)}>Add remit e-mail</button>}
          </span>
        )
      },
      text: (r) => r.email,
    },
  ]

  const factorColumns: Array<ColumnDef<FactorSummary>> = [
    {
      key: 'name', header: 'Factoring company', width: 320,
      render: (r) => (
        <span title={r.otherNames.length ? `Also spelled: ${r.otherNames.join('; ')}` : undefined}>
          {r.name}{r.otherNames.length > 0 && <span className="tms-muted"> +{r.otherNames.length} spelling{r.otherNames.length === 1 ? '' : 's'}</span>}
        </span>
      ),
      text: (r) => r.name,
    },
    { key: 'n', header: 'Carriers', width: 90, align: 'right', render: (r) => r.carrierCount, sortValue: (r) => r.carrierCount },
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
                await setFactorRemitEmail({ factorName: r.name, email })
                toast.success(email ? 'Remit e-mail saved for every carrier paid through this factor' : 'Remit e-mail cleared')
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
      text: (r) => r.email,
    },
    {
      key: 'source', header: 'Status', width: 170,
      render: (r) => (
        <TmsBadge tone={r.source === 'SET' ? 'green' : r.source === 'CARRIERS' ? 'gray' : r.source === 'CONFLICT' ? 'orange' : 'red'}>
          {FACTOR_SOURCE_LABEL[r.source]}
        </TmsBadge>
      ),
      text: (r) => FACTOR_SOURCE_LABEL[r.source],
    },
  ]

  const busy = loading || methods === null
  const rows = kind === 'carriers' ? shownCarriers : shownFactors
  const total = kind === 'carriers' ? carrierRows.length : factorRows.length

  return (
    <TmsPage title="Remit e-mails">
      <p className="tms-muted mb-3" style={{ maxWidth: 760 }}>
        Where remittance advice goes when a carrier is paid. A factoring company has one address, shared by every carrier it funds;
        a carrier paid directly has its own.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TmsSegmentedTabs
          aria-label="Carriers or factoring companies"
          active={kind}
          onSelect={(k) => { setKind(k as Kind); setEditing(null); setLimit(PAGE_SIZE) }}
          tabs={[
            { key: 'carriers', label: `Carriers${missingCarriers ? ` · ${missingCarriers} missing` : ''}` },
            { key: 'factors', label: `Factoring companies${missingFactors ? ` · ${missingFactors} to fix` : ''}` },
          ]}
        />
        <TmsInput
          aria-label="Search remit e-mails"
          value={query}
          placeholder={kind === 'carriers' ? 'Search carrier, MC, factor or e-mail' : 'Search factoring company or e-mail'}
          style={{ minWidth: 300 }}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE) }}
        />
        <label className="inline-flex items-center gap-1 text-sm">
          <input type="checkbox" checked={missingOnly} onChange={(e) => { setMissingOnly(e.target.checked); setLimit(PAGE_SIZE) }} />
          {kind === 'carriers' ? 'Missing remit e-mail only' : 'Missing or conflicting only'}
        </label>
        <span className="tms-muted" style={{ fontSize: 12 }}>{busy ? 'Loading…' : `${rows.length} of ${total}`}</span>
      </div>

      {(loadError || carriersError) && <p className="mb-2 text-sm" style={{ color: 'var(--tms-badge-red)' }}>{loadError ?? carriersError}</p>}

      {kind === 'carriers' ? (
        <TmsTable
          columns={carrierColumns}
          rows={shownCarriers.slice(0, limit)}
          rowKey={(r) => r.id}
          empty={busy ? 'Loading…' : 'No carriers match.'}
        />
      ) : (
        <TmsTable
          columns={factorColumns}
          rows={shownFactors.slice(0, limit)}
          rowKey={(r) => r.key}
          empty={busy ? 'Loading…' : 'No factoring companies match.'}
        />
      )}
      {rows.length > limit && (
        <div className="mt-3">
          <TmsButton variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, rows.length - limit)} more</TmsButton>
        </div>
      )}
    </TmsPage>
  )
}
