/**
 * Settings → Data → Aljex reconciliation (Step AW E.2).
 *
 * Per entity (customers, carriers, AR, AP, loads): what matches, what is in Aljex only, what is in BCAT only,
 * which fields differ, and the money side by side to the cent. Equality is not required: every difference is set
 * to Open balance or Approved with a reason. Deciding and signing off belong to the `aljexSignoff` grant holder
 * (the Lambda refuses everybody else, ADMIN and owner included); everybody who can open the page may read it and
 * download the CSV.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Scale } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { useAuth } from '@/hooks/useAuth'
import { decideAljexReconcile, getAljexReconcile, listAljexImports, listAljexReconcile, signoffAljexReconcile, startAljexReconcile } from '@/lib/apiClient'
import {
  ALJEX_SIGNOFF_PAGE_KEY,
  centsText,
  RECON_ENTITIES,
  RECON_ENTITY_LABEL,
  type MoneyLine,
  type ReconEntity,
  type ReconJobSummary,
  type ReconOutcome,
  type ReconPage,
  type ReconRowState,
} from '@/lib/aljexReconcile'
import type { AljexImportJob } from '@/types/tms'

const POLL_MS = 3000
const PAGE_SIZE = 100
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—')

const KIND_LABEL: Record<string, string> = {
  ALJEX_ONLY: 'In Aljex, missing in BCAT',
  BCAT_ONLY: 'In BCAT, not in Aljex',
  MISMATCH: 'Field differs',
  MONEY: 'Amount differs',
  MONEY_TOTAL: 'Total differs',
}

const OUTCOME_LABEL: Record<ReconOutcome, string> = { OPEN_BALANCE: 'Open balance', APPROVED: 'Approved' }

function cell(field: string | null, v: string | number | null): string {
  if (v == null) return '—'
  return typeof v === 'number' && field != null && /Cents$/.test(field) ? `$${centsText(v)}` : String(v)
}

const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${centsText(Math.abs(cents))}`

function MoneyTable({ title, lines }: { title: string; lines: MoneyLine[] }) {
  if (lines.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <GroupLabel>{title}</GroupLabel>
      <div className="tms-table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
        <table className="tms-table">
          <thead><tr><th>Name</th><th style={{ textAlign: 'right' }}>Aljex</th><th style={{ textAlign: 'right' }}>BCAT</th><th style={{ textAlign: 'right' }}>Difference</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>{l.name}</td>
                <td style={{ textAlign: 'right' }}>{dollars(l.aljexCents)}</td>
                <td style={{ textAlign: 'right' }}>{dollars(l.bcatCents)}</td>
                <td style={{ textAlign: 'right' }}>{l.diffCents === 0 ? '—' : dollars(l.diffCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function AljexReconciliationPage() {
  const { hasPageAccess } = useAuth()
  // `hasPageAccess` never opens this key for a role: only the per-user grant does. The Lambda is the boundary.
  const canDecide = hasPageAccess(ALJEX_SIGNOFF_PAGE_KEY)

  const [jobs, setJobs] = useState<ReconJobSummary[]>([])
  const [imports, setImports] = useState<AljexImportJob[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceFor, setSourceFor] = useState<Partial<Record<ReconEntity, string>>>({})
  const [customersJobId, setCustomersJobId] = useState('')

  const [openId, setOpenId] = useState<string | null>(null)
  const [page, setPage] = useState<ReconPage | null>(null)
  const [kind, setKind] = useState('ALL')
  const [state, setState] = useState<ReconRowState>('OPEN')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [outcome, setOutcome] = useState<ReconOutcome>('APPROVED')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')

  const refresh = useCallback(async () => {
    const [r, list] = await Promise.all([listAljexReconcile(), listAljexImports()])
    setJobs(r.jobs)
    setImports(list.filter((j) => j.kind !== 'RECONCILE' && j.kind !== 'MCP_SYNC'))
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([listAljexReconcile(), listAljexImports()])
      .then(([r, list]) => {
        if (cancelled) return
        setJobs(r.jobs)
        setImports(list.filter((j) => j.kind !== 'RECONCILE' && j.kind !== 'MCP_SYNC'))
      })
      .catch((e) => { if (!cancelled) setError(messageOf(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const loadPage = useCallback(async () => {
    if (!openId) return
    setPage(await getAljexReconcile({ jobId: openId, kind: kind === 'ALL' ? undefined : kind, state, q: q || undefined, offset, limit: PAGE_SIZE }))
  }, [openId, kind, state, q, offset])

  useEffect(() => {
    if (!openId) return undefined
    let cancelled = false
    getAljexReconcile({ jobId: openId, kind: kind === 'ALL' ? undefined : kind, state, q: q || undefined, offset, limit: PAGE_SIZE })
      .then((p) => { if (!cancelled) setPage(p) })
      .catch((e) => { if (!cancelled) setError(messageOf(e)) })
    return () => { cancelled = true }
  }, [openId, kind, state, q, offset])

  const running = jobs.some((j) => j.status === 'RUNNING')
  useEffect(() => {
    if (!running) return undefined
    const t = setInterval(() => {
      refresh().then(() => loadPage()).catch((e) => setError(messageOf(e)))
    }, POLL_MS)
    return () => clearInterval(t)
  }, [running, refresh, loadPage])

  const latest = useMemo(() => {
    const out: Partial<Record<ReconEntity, ReconJobSummary>> = {}
    for (const j of jobs) if (!out[j.entity]) out[j.entity] = j
    return out
  }, [jobs])

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try { await fn() } catch (e) { setError(messageOf(e)) } finally { setBusy(null) }
  }

  const start = (entity: ReconEntity) => run(`start-${entity}`, async () => {
    const sourceJobId = sourceFor[entity]
    if (!sourceJobId) throw new Error('Choose the import job that holds the Aljex file first')
    const r = await startAljexReconcile({ entity, sourceJobId, customersJobId: entity === 'AR' && customersJobId ? customersJobId : null })
    toast.success(`${RECON_ENTITY_LABEL[entity]}: comparing. This page updates by itself.`)
    setOpenId(r.job.id)
    setOffset(0)
    setSelected(new Set())
    await refresh()
  })

  const open = (id: string) => {
    setOpenId(id)
    setOffset(0)
    setSelected(new Set())
    setPage(null)
  }

  const decide = (all: boolean) => run('decide', async () => {
    if (!openId || !page) return
    const keys = all ? [] : [...selected]
    const r = await decideAljexReconcile({ jobId: openId, keys, outcome, reason, ...(all ? { filter: { kind: kind === 'ALL' ? undefined : kind, q: q || undefined } } : {}) })
    toast.success(`${r.decided} difference(s) set to ${OUTCOME_LABEL[outcome]}`)
    setSelected(new Set())
    setReason('')
    await Promise.all([refresh(), loadPage()])
  })

  const signoff = () => run('signoff', async () => {
    if (!openId) return
    await signoffAljexReconcile({ jobId: openId, note: note || undefined })
    toast.success('Signed off')
    setNote('')
    await Promise.all([refresh(), loadPage()])
  })

  const downloadCsv = () => run('csv', async () => {
    if (!openId) return
    const r = await getAljexReconcile({ jobId: openId, exportCsv: true, limit: 1 })
    if (r.csvUrl) window.open(r.csvUrl, '_blank', 'noopener')
  })

  if (loading) return <Loading />

  const job = page?.job ?? jobs.find((j) => j.id === openId) ?? null
  const stats = job?.stats ?? null
  const signed = job?.signoff ?? null
  const report = page?.report ?? null
  const totalPages = page ? Math.max(1, Math.ceil(page.total / PAGE_SIZE)) : 1
  const decideBlock = !canDecide
    ? 'Only the person holding the Aljex sign-off grant can decide differences.'
    : signed
      ? 'Signed off.'
      : !reason.trim()
        ? 'A reason is required.'
        : null

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={Scale}
        title="Aljex reconciliation"
        description="Aljex and BCAT side by side, entity by entity. Nothing has to be equal: every difference is left as an open balance or approved with a reason, then signed off."
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}
          {!canDecide ? <TmsAlert tone="blue">You can read every report and download the CSV. Deciding differences and signing off needs the Aljex sign-off grant.</TmsAlert> : null}
          <Panel>
            <GroupLabel>Customers file for AR due dates (optional)</GroupLabel>
            <TmsSelect value={customersJobId} onChange={(e) => setCustomersJobId(e.target.value)} placeholder="Use BCAT customer terms">
              {imports.map((j) => <option key={j.id} value={j.id}>{j.fileName ?? j.id} · {when(j.createdAt)}</option>)}
            </TmsSelect>
          </Panel>
          <div className="tms-table-wrap">
            <table className="tms-table" data-testid="recon-entities">
              <thead><tr><th>Entity</th><th>Aljex file / import job</th><th>Last run</th><th>Differences</th><th>Sign-off</th><th /></tr></thead>
              <tbody>
                {RECON_ENTITIES.map((entity) => {
                  const j = latest[entity]
                  return (
                    <tr key={entity}>
                      <td><strong>{RECON_ENTITY_LABEL[entity]}</strong></td>
                      <td>
                        <TmsSelect aria-label={`${RECON_ENTITY_LABEL[entity]} source`} value={sourceFor[entity] ?? ''} onChange={(e) => setSourceFor((s) => ({ ...s, [entity]: e.target.value }))} placeholder="Choose…">
                          {imports.map((i) => <option key={i.id} value={i.id}>{i.fileName ?? i.id} · {when(i.createdAt)}</option>)}
                        </TmsSelect>
                      </td>
                      <td>{j ? <>{when(j.createdAt)} <TmsBadge tone={j.status === 'APPLIED' ? 'green' : j.status === 'FAILED' ? 'red' : 'blue'}>{j.status === 'APPLIED' ? 'Ready' : j.status}</TmsBadge></> : <span className="tms-muted">never</span>}</td>
                      <td>{j?.stats ? `${j.stats.undecided} undecided of ${j.stats.total}` : j?.counts ? `${j.counts.diffs}` : '—'}</td>
                      <td>{j?.signoff ? <TmsBadge tone="green">Signed off · {j.signoff.approver}</TmsBadge> : <span className="tms-muted">not yet</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <TmsButton size="sm" onClick={() => start(entity)} disabled={busy != null}>{j ? 'Run again' : 'Run'}</TmsButton>{' '}
                        {j ? <TmsButton size="sm" variant="ghost" onClick={() => open(j.id)}>Open</TmsButton> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Stack>
      </SettingsCard>

      {job ? (
        <SettingsCard icon={Scale} title={`${RECON_ENTITY_LABEL[job.entity]} report`} description={`Compared ${when(job.createdAt)} as of ${job.asOf ?? '—'}.`}>
          <Stack>
            {job.status === 'FAILED' ? <ErrorText>{job.error ?? 'The comparison failed.'}</ErrorText> : null}
            {job.status === 'RUNNING' ? <Loading /> : null}
            {signed ? (
              <TmsAlert tone="green">
                Signed off by {signed.approver} on {when(signed.at)}: {signed.openBalance} left as open balance, {signed.approved} approved.{signed.note ? ` Note: ${signed.note}` : ''}
              </TmsAlert>
            ) : null}
            {report ? (
              <>
                <div className="tms-grid tms-grid-3" data-testid="recon-counts">
                  <div><div className="tms-muted">Matched</div><strong>{report.counts.matched}</strong></div>
                  <div><div className="tms-muted">In Aljex, missing in BCAT</div><strong>{report.counts.aljexOnly}</strong></div>
                  <div><div className="tms-muted">In BCAT, not in Aljex</div><strong>{report.counts.bcatOnly}</strong></div>
                  <div><div className="tms-muted">Rows with a differing field or amount</div><strong>{report.counts.mismatched}</strong></div>
                  <div><div className="tms-muted">Decided</div><strong>{stats ? `${stats.decided} of ${stats.total}` : '—'}</strong></div>
                  <div><div className="tms-muted">Open balance / Approved</div><strong>{stats ? `${stats.openBalance} / ${stats.approved}` : '—'}</strong></div>
                </div>
                {report.notes.map((n) => <Hint key={n}>{n}</Hint>)}
                {Object.keys(report.excluded).length > 0 ? (
                  <Hint>Left out of the Aljex side: {Object.entries(report.excluded).map(([k, v]) => `${v} ${k}`).join('; ')}.</Hint>
                ) : null}
                {report.money ? (
                  <div data-testid="recon-money">
                    <GroupLabel>Money, side by side</GroupLabel>
                    <div className="tms-grid tms-grid-3">
                      <div><div className="tms-muted">Aljex open ({report.money.aljexItems})</div><strong>{dollars(report.money.aljexCents)}</strong></div>
                      <div><div className="tms-muted">BCAT open ({report.money.bcatItems})</div><strong>{dollars(report.money.bcatCents)}</strong></div>
                      <div><div className="tms-muted">Difference</div><strong>{dollars(report.money.diffCents)}</strong></div>
                    </div>
                    <MoneyTable title="Aging buckets (by due date)" lines={report.money.byBucket} />
                    {report.money.fileBuckets ? <MoneyTable title="Aging buckets as the Aljex file prints them" lines={report.money.fileBuckets} /> : null}
                    <MoneyTable title={report.entity === 'AR' ? 'By customer' : 'By carrier'} lines={report.money.byParty} />
                  </div>
                ) : null}
              </>
            ) : null}

            {page && report ? (
              <>
                <GroupLabel>Differences</GroupLabel>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                  <TmsField label="Kind">
                    <TmsSelect value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0) }}>
                      <option value="ALL">All</option>
                      {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </TmsSelect>
                  </TmsField>
                  <TmsField label="State">
                    <TmsSelect value={state} onChange={(e) => { setState(e.target.value as ReconRowState); setOffset(0) }}>
                      <option value="OPEN">Undecided</option>
                      <option value="DECIDED">Decided</option>
                      <option value="ALL">All</option>
                    </TmsSelect>
                  </TmsField>
                  <TmsField label="Search"><TmsInput value={q} onChange={(e) => { setQ(e.target.value); setOffset(0) }} placeholder="Number, name or field" /></TmsField>
                  <TmsButton variant="secondary" onClick={downloadCsv} disabled={busy != null}>Download CSV</TmsButton>
                </div>

                {canDecide && !signed ? (
                  <Panel>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                      <TmsField label="Decision">
                        <TmsSelect value={outcome} onChange={(e) => setOutcome(e.target.value as ReconOutcome)}>
                          <option value="APPROVED">Approved</option>
                          <option value="OPEN_BALANCE">Open balance</option>
                        </TmsSelect>
                      </TmsField>
                      <TmsField label="Reason (required)"><TmsInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 280 }} /></TmsField>
                      <TmsButton variant="primary" disabled={busy != null || decideBlock != null || selected.size === 0} onClick={() => decide(false)}>Apply to {selected.size} selected</TmsButton>
                      <TmsButton disabled={busy != null || decideBlock != null || state !== 'OPEN'} onClick={() => decide(true)}>Apply to all undecided matching the filter</TmsButton>
                    </div>
                  </Panel>
                ) : null}

                <div className="tms-table-wrap">
                  <table className="tms-table" data-testid="recon-rows">
                    <thead>
                      <tr>
                        <th>{canDecide && !signed ? (
                          <input type="checkbox" aria-label="Select all on this page" checked={page.rows.length > 0 && page.rows.every((r) => selected.has(r.key))} onChange={(e) => setSelected(e.target.checked ? new Set(page.rows.map((r) => r.key)) : new Set())} />
                        ) : null}</th>
                        <th>Kind</th><th>Reference</th><th>Name</th><th>Field</th><th>Aljex</th><th>BCAT</th><th style={{ textAlign: 'right' }}>Difference</th><th>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.rows.map((r) => (
                        <tr key={r.key}>
                          <td>{canDecide && !signed ? (
                            <input type="checkbox" aria-label={`Select ${r.ref}`} checked={selected.has(r.key)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n })} />
                          ) : null}</td>
                          <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                          <td>{r.ref}</td>
                          <td>{r.name}</td>
                          <td>{r.fieldLabel ?? '—'}</td>
                          <td>{cell(r.field, r.aljex)}</td>
                          <td>{cell(r.field, r.bcat)}</td>
                          <td style={{ textAlign: 'right' }}>{r.diffCents == null ? '—' : dollars(r.diffCents)}</td>
                          <td>{r.decision ? <><TmsBadge tone={r.decision.outcome === 'APPROVED' ? 'green' : 'orange'}>{OUTCOME_LABEL[r.decision.outcome]}</TmsBadge> <span className="tms-muted" title={r.decision.reason}>{r.decision.approver} · {when(r.decision.at)} · {r.decision.reason}</span></> : <span className="tms-muted">undecided</span>}</td>
                        </tr>
                      ))}
                      {page.rows.length === 0 ? <tr><td colSpan={9} className="tms-muted">No differences match.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <TmsButton size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</TmsButton>
                  <span className="tms-muted">{page.total === 0 ? 0 : offset + 1}–{Math.min(page.total, offset + PAGE_SIZE)} of {page.total} · page {Math.floor(offset / PAGE_SIZE) + 1} of {totalPages}</span>
                  <TmsButton size="sm" variant="ghost" disabled={offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</TmsButton>
                </div>

                {!signed ? (
                  <Panel>
                    <GroupLabel>Sign-off</GroupLabel>
                    <Hint>Every difference needs a decision first{stats ? ` (${stats.undecided} still undecided)` : ''}.</Hint>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                      <TmsField label="Note (optional)"><TmsInput value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} /></TmsField>
                      <TmsButton variant="approve" onClick={signoff} disabled={busy != null || !canDecide || !stats || stats.undecided > 0 || job.status !== 'APPLIED'}>Sign off</TmsButton>
                    </div>
                    {!canDecide ? <Hint>Only the person holding the Aljex sign-off grant can sign off.</Hint> : null}
                  </Panel>
                ) : null}
              </>
            ) : null}
          </Stack>
        </SettingsCard>
      ) : null}
    </div>
  )
}

export default AljexReconciliationPage
