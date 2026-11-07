/**
 * Customers > Billing setup (Step AW D.2): who is billed how. Method, AP e-mail, copy list and
 * the last 12 months of shipments for every active customer; Missing filter; inline edit; CSV
 * export, the "needs your answer" report, and CSV import with a preview before anything is written.
 * Held ("needs review") import rows are applied only when ticked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, FileQuestion, Pencil, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { useDirectory, type CustomerRecord } from '@/hooks/useDirectory'
import {
  TmsBadge, TmsButton, TmsDialog, TmsInput, TmsScrollPage, TmsSegmentedTabs, TmsSelect, TmsStatRow, TmsTable,
} from '@/features/tms/kit'
import type { ColumnDef, TmsTone } from '@/features/tms/kit'
import { listShipmentsByMonthFiltered } from '@/lib/apiClient'
import { validateBillingFields, parseEmailList, type BillingMethod } from '@/lib/billingMethod'
import { buildDuplicateIndex } from '@/lib/customerDuplicates'
import { saveBlob } from '@/lib/download'
import {
  applyPatchOf, billingCounts, exportBillingCsv, isMissing, lastMonths, loadsByCustomer, needsAnswerCsv,
  previewBillingImport, questionsFor, stateOf, type BillingState, type ImportPreview, type ImportStatus,
} from '@/lib/billingSetupCsv'

type View = 'all' | 'missing'

interface Draft { method: '' | BillingMethod; apEmail: string; copy: string }

const STATE_TONE: Record<BillingState, TmsTone> = { FACTOR: 'blue', MANUAL: 'green', NOT_SET: 'orange' }
const STATE_LABEL: Record<BillingState, string> = { FACTOR: 'Factor', MANUAL: 'Manual', NOT_SET: 'Not set' }
const STATUS_TONE: Record<ImportStatus, TmsTone> = { CHANGED: 'green', UNCHANGED: 'gray', HELD: 'orange', INVALID: 'red', UNKNOWN: 'red', DUPLICATE: 'red' }
const STATUS_LABEL: Record<ImportStatus, string> = {
  CHANGED: 'Will change', UNCHANGED: 'No change', HELD: 'Needs review', INVALID: 'Invalid', UNKNOWN: 'Unknown customer', DUPLICATE: 'Duplicate row',
}
const MONTHS = lastMonths(new Date(), 12)

const draftOf = (c: CustomerRecord): Draft => ({
  method: c.billingMethod ?? '', apEmail: c.apEmail ?? '', copy: (c.invoiceCopyEmails ?? []).join('; '),
})

export function BillingSetupPage() {
  const dir = useDirectory({ includeArchived: false, locations: false })
  const [view, setView] = useState<View>('all')
  const [query, setQuery] = useState('')
  const [loads, setLoads] = useState<ReadonlyMap<string, number> | null>(null)
  const [loadsError, setLoadsError] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ method: '', apEmail: '', copy: '' })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set())
  const [applying, setApplying] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Shipments per customer over the last 12 pickup months; a failed read shows dashes, never zeros.
  useEffect(() => {
    let live = true
    Promise.all(MONTHS.map((m) => listShipmentsByMonthFiltered(m)))
      .then((months) => { if (live) setLoads(loadsByCustomer(months.flat())) })
      .catch(() => { if (live) setLoadsError(true) })
    return () => { live = false }
  }, [])

  const counts = useMemo(() => billingCounts(dir.customers), [dir.customers])
  const duplicates = useMemo(() => buildDuplicateIndex(dir.customers), [dir.customers])
  const missingCount = useMemo(() => dir.customers.filter(isMissing).length, [dir.customers])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.customers
      .filter((c) => view === 'all' || isMissing(c))
      .filter((c) => !q || [c.name, c.aljexCode, c.apEmail].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [dir.customers, view, query])

  const startEdit = useCallback((c: CustomerRecord) => { setEditId(c.id); setDraft(draftOf(c)) }, [])

  const errors = useMemo(
    () => validateBillingFields({ billingMethod: draft.method || null, apEmail: draft.apEmail, invoiceCopyEmails: parseEmailList(draft.copy) }),
    [draft],
  )
  const errorText = Object.values(errors).join(' · ')

  const save = async (c: CustomerRecord) => {
    if (errorText) return
    setSaving(true)
    try {
      await dir.saveCustomer(c, {
        billingMethod: draft.method || null,
        apEmail: draft.apEmail.trim().toLowerCase() || null,
        invoiceCopyEmails: parseEmailList(draft.copy),
        // A person saved the row, so the review flag is answered.
        billingNeedsReview: null,
      })
      toast.success('Billing method saved')
      setEditId(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const stamp = new Date().toISOString().slice(0, 10)
  const exportAll = () => saveBlob(new Blob([exportBillingCsv(dir.customers)], { type: 'text/csv' }), `billing-setup-${stamp}.csv`)
  const exportAnswers = () => saveBlob(new Blob([needsAnswerCsv(dir.customers, loads ?? new Map())], { type: 'text/csv' }), `billing-needs-your-answer-${stamp}.csv`)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setConfirmed(new Set())
    setPreview(previewBillingImport(await file.text(), dir.customers))
    if (fileRef.current) fileRef.current.value = ''
  }

  const toApply = useMemo(
    () => (preview?.rows ?? []).filter((r) => applyPatchOf(r, confirmed) !== null),
    [preview, confirmed],
  )

  const apply = async () => {
    if (!preview) return
    setApplying(true)
    let ok = 0
    const failed: string[] = []
    for (const row of toApply) {
      const patch = applyPatchOf(row, confirmed)
      const current = dir.customers.find((c) => c.id === row.customerId)
      if (!patch || !current) continue
      try { await dir.saveCustomer(current, patch); ok++ } catch (e) { failed.push(`${row.customerName}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    setApplying(false)
    if (failed.length) toast.error(`${ok} applied, ${failed.length} failed. ${failed[0]}`)
    else toast.success(`${ok} customer${ok === 1 ? '' : 's'} updated`)
    setPreview(null)
    void dir.refresh()
  }

  const columns: Array<ColumnDef<CustomerRecord>> = [
    {
      key: 'name', header: 'Customer', width: 240,
      render: (c) => (
        <>
          <Link to={`/tms/customers?customer=${encodeURIComponent(c.id)}`}>{c.name}</Link>
          {c.aljexCode ? <span className="tms-muted"> #{c.aljexCode}</span> : null}
          {duplicates.has(c.id) ? <> <TmsBadge tone="orange" title="Another account has the same name">Possible duplicate</TmsBadge></> : null}
        </>
      ),
    },
    {
      key: 'method', header: 'Method', width: 130,
      render: (c) => editId === c.id
        ? (
          <TmsSelect
            aria-label={`${c.name} method`} value={draft.method}
            onChange={(e) => setDraft({ ...draft, method: e.target.value as Draft['method'] })}
            options={[{ value: '', label: 'Not set' }, { value: 'FACTOR', label: 'Factor' }, { value: 'MANUAL', label: 'Manual' }]}
          />
        )
        : <TmsBadge tone={STATE_TONE[stateOf(c)]}>{STATE_LABEL[stateOf(c)]}</TmsBadge>,
    },
    {
      key: 'apEmail', header: 'AP e-mail', width: 230,
      render: (c) => editId === c.id
        ? <TmsInput aria-label={`${c.name} AP e-mail`} value={draft.apEmail} onChange={(e) => setDraft({ ...draft, apEmail: e.target.value })} />
        : (c.apEmail || <span className="tms-muted">—</span>),
    },
    {
      key: 'copy', header: 'Copied contacts', width: 260,
      render: (c) => editId === c.id
        ? <TmsInput aria-label={`${c.name} copy list`} value={draft.copy} placeholder="a@x.com; b@x.com" onChange={(e) => setDraft({ ...draft, copy: e.target.value })} />
        : ((c.invoiceCopyEmails ?? []).join(', ') || <span className="tms-muted">—</span>),
    },
    { key: 'terms', header: 'Terms', width: 80, render: (c) => (c.paymentTermsDays != null ? `Net ${c.paymentTermsDays}` : '—') },
    {
      key: 'loads', header: 'Loads 12 mo', width: 100,
      render: (c) => (loads ? loads.get(c.id) ?? 0 : loadsError ? '—' : '…'),
    },
    {
      key: 'note', header: 'Review', width: 220,
      render: (c) => {
        const q = questionsFor(c)
        return q.length ? <span className="tms-muted">{q.join(' ')}</span> : null
      },
    },
    {
      key: 'actions', header: '', width: 150,
      render: (c) => editId === c.id
        ? (
          <span>
            <TmsButton size="sm" variant="primary" disabled={saving || errorText !== ''} title={errorText || undefined} onClick={() => void save(c)}>Save</TmsButton>{' '}
            <TmsButton size="sm" onClick={() => setEditId(null)}>Cancel</TmsButton>
          </span>
        )
        : <TmsButton size="sm" onClick={() => startEdit(c)} aria-label={`Edit ${c.name}`}><Pencil size={12} aria-hidden="true" /> Edit</TmsButton>,
    },
  ]

  return (
    <TmsScrollPage
      title="Billing setup"
      subtitle="How each customer is invoiced: the factor, or by e-mail to their AP address."
      width="full"
      actions={(
        <>
          <TmsButton size="sm" onClick={exportAll}><Download size={14} aria-hidden="true" /> Export CSV</TmsButton>
          <TmsButton size="sm" onClick={exportAnswers}><FileQuestion size={14} aria-hidden="true" /> Needs your answer CSV</TmsButton>
          <TmsButton size="sm" onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" /> Import CSV</TmsButton>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden aria-label="Import billing CSV" data-testid="billing-import-file" onChange={(e) => void onFile(e.target.files?.[0])} />
        </>
      )}
      toolbar={(
        <>
          <TmsSegmentedTabs
            size="sm" aria-label="Billing filter" active={view} onSelect={(k) => setView(k as View)}
            tabs={[{ key: 'all', label: 'All', count: dir.customers.length }, { key: 'missing', label: 'Missing', count: missingCount }]}
          />
          <TmsInput placeholder="Search customer, account or e-mail" aria-label="Search billing setup" value={query} onChange={(e) => setQuery(e.target.value)} />
        </>
      )}
    >
      <TmsStatRow
        aria-label="Billing method counts" columns={4} compact
        items={[
          { key: 'factor', label: 'Factor', value: String(counts.factor), testId: 'count-factor' },
          { key: 'manual', label: 'Manual', value: String(counts.manual), testId: 'count-manual' },
          { key: 'notSet', label: 'Not set', value: String(counts.notSet), tone: counts.notSet ? 'warn' : undefined, testId: 'count-not-set' },
          { key: 'review', label: 'Needs review', value: String(counts.needsReview), tone: counts.needsReview ? 'warn' : undefined, testId: 'count-needs-review' },
        ]}
      />
      {dir.error ? <p role="alert" className="tms-muted">{dir.error}</p> : null}
      <TmsTable
        columns={columns} rows={rows} rowKey={(c) => c.id}
        empty={dir.loading ? 'Loading customers…' : view === 'missing' ? 'Every customer has a billing method.' : 'No customers match.'}
      />

      <TmsDialog
        open={preview !== null} onOpenChange={(o) => { if (!o) setPreview(null) }}
        title="Import preview" className="tms-dialog-wide"
        description={preview?.error ? undefined : 'Nothing is written until you press Apply. Rows that need review are applied only when ticked.'}
        footer={(
          <>
            <TmsButton onClick={() => setPreview(null)}>Cancel</TmsButton>
            <TmsButton variant="primary" disabled={applying || toApply.length === 0} onClick={() => void apply()}>
              {applying ? 'Applying…' : `Apply ${toApply.length} change${toApply.length === 1 ? '' : 's'}`}
            </TmsButton>
          </>
        )}
      >
        {preview?.error ? <p role="alert">{preview.error}</p> : preview ? (
          <>
            <p data-testid="import-counts">
              {(Object.keys(STATUS_LABEL) as ImportStatus[]).filter((s) => preview.counts[s] > 0).map((s) => `${preview.counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ') || 'No rows.'}
            </p>
            <TmsTable
              columns={[
                { key: 'line', header: 'Line', width: 60, render: (r) => r.line },
                { key: 'customer', header: 'Customer', render: (r) => <>{r.customerName || '—'}{r.aljexCode ? <span className="tms-muted"> #{r.aljexCode}</span> : null}</> },
                { key: 'status', header: 'Result', width: 150, render: (r) => <TmsBadge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</TmsBadge> },
                {
                  key: 'to', header: 'New value',
                  render: (r) => (r.patch ? `${r.patch.billingMethod}${r.patch.apEmail ? ` · ${r.patch.apEmail}` : ''}${r.patch.invoiceCopyEmails.length ? ` · cc ${r.patch.invoiceCopyEmails.join(', ')}` : ''}` : '—'),
                },
                { key: 'why', header: 'Note', render: (r) => r.reason ?? '' },
                {
                  key: 'confirm', header: 'Confirm', width: 80,
                  render: (r) => (r.status === 'HELD'
                    ? (
                      <input
                        type="checkbox" aria-label={`Confirm line ${r.line}`} checked={confirmed.has(r.line)}
                        onChange={(e) => setConfirmed((prev) => { const next = new Set(prev); if (e.target.checked) next.add(r.line); else next.delete(r.line); return next })}
                      />
                    )
                    : null),
                },
              ]}
              rows={preview.rows.filter((r) => r.status !== 'UNCHANGED')}
              rowKey={(r) => String(r.line)}
              empty="Nothing to change."
            />
          </>
        ) : null}
      </TmsDialog>
    </TmsScrollPage>
  )
}
