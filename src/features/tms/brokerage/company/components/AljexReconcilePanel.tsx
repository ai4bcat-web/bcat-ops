/**
 * Step 6: the reconciliation report (file value · BCAT value · difference), report downloads, optional
 * "Aljex reported" totals to compare against, the PRO-counter seed card and the MyCarrierPackets sync card.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsField, TmsInput } from '@/features/tms/kit'
import { ErrorText, GroupLabel, Hint, Panel, Stack } from '@/features/settings/settingsKit'
import {
  getAljexImport, getAljexReportLinks, listIntegrations, reconcileAljexImport, seedProCounter, syncImportedCarriers,
} from '@/lib/apiClient'
import type { AljexImportJob, AljexReportLink, ImportReportSummary, SeedProCounterResult } from '@/types/tms'
import { centsFromTyped, dollars } from './aljexImportLogic'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Compare({ label, bcat, typed }: { label: string; bcat: number | null; typed: string }) {
  const reported = centsFromTyped(typed)
  const diff = reported != null && bcat != null ? bcat - reported : null
  return (
    <tr>
      <td>{label}</td>
      <td>{reported != null ? dollars(reported) : '—'}</td>
      <td>{dollars(bcat)}</td>
      <td data-testid={`compare-${label}`}>
        {diff == null ? '—' : diff === 0 ? <TmsBadge tone="green">Matches</TmsBadge> : <TmsBadge tone="red">{dollars(diff)}</TmsBadge>}
      </td>
    </tr>
  )
}

export function AljexReconcilePanel({ job, onJob }: { job: AljexImportJob; onJob: (job: AljexImportJob) => void }) {
  const [summary, setSummary] = useState<ImportReportSummary | null>(job.summary ?? null)
  const [links, setLinks] = useState<AljexReportLink[]>([])
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reportedAr, setReportedAr] = useState('')
  const [reportedAp, setReportedAp] = useState('')
  const [counter, setCounter] = useState<SeedProCounterResult | null>(null)
  const [enableNumeric, setEnableNumeric] = useState(true)
  const [mcpLive, setMcpLive] = useState<boolean | null>(null)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listIntegrations()
      .then((rows) => { if (!cancelled) setMcpLive(rows.some((r) => r.provider === 'MYCARRIERPACKETS' && r.kind === 'PROVIDER' && r.mode === 'LIVE')) })
      .catch(() => { if (!cancelled) setMcpLive(false) })
    return () => { cancelled = true }
  }, [])
  // A job reopened with a finished reconciliation already has its report files; fetch them without re-running it.
  const hasSummary = job.summary != null
  useEffect(() => {
    if (!hasSummary) return undefined
    let cancelled = false
    getAljexReportLinks(job.id).then((rows) => { if (!cancelled) setLinks(rows) }).catch(() => {})
    return () => { cancelled = true }
  }, [hasSummary, job.id])
  useEffect(() => {
    if (!waiting) return undefined
    let cancelled = false
    const poll = setInterval(() => {
      getAljexImport(job.id)
        .then(async (next) => {
          if (cancelled || !next.summary) return
          setSummary(next.summary)
          setWaiting(false)
          onJob(next)
          setLinks(await getAljexReportLinks(job.id).catch(() => []))
        })
        .catch((e) => { if (!cancelled) { setError(messageOf(e)); setWaiting(false) } })
    }, 2500)
    return () => { cancelled = true; clearInterval(poll) }
  }, [waiting, job.id, onJob])


  const run = useCallback(async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try { await fn() } catch (e) { setError(messageOf(e)) } finally { setBusy(null) }
  }, [])

  const reconcile = () => run('reconcile', async () => {
    const r = await reconcileAljexImport(job.id)
    onJob(r.job)
    if (r.summary) {
      setSummary(r.summary)
      setLinks(await getAljexReportLinks(job.id).catch(() => []))
    } else {
      setWaiting(true)
    }
  })

  const previewCounter = () => run('counter', async () => setCounter(await seedProCounter({ apply: false, jobId: job.id })))
  const applyCounter = () => run('counter', async () => {
    const r = await seedProCounter({ apply: true, enableNumericScheme: enableNumeric, jobId: job.id })
    setCounter(r)
    toast.success(r.applied ? `PRO counter set to ${r.target}` : 'PRO counter unchanged')
  })
  const sync = () => run('sync', async () => {
    const r = await syncImportedCarriers(job.id)
    setSyncNote(r.ready ? 'Sync started.' : r.reason ?? 'Not ready.')
    if (r.job) onJob(r.job)
  })

  return (
    <Stack>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Panel>
        <GroupLabel>Reconciliation report</GroupLabel>
        <TmsButton variant="primary" disabled={busy != null || waiting} onClick={() => void reconcile()}>
          {busy === 'reconcile' || waiting ? 'Reconciling…' : summary ? 'Reconcile again' : 'Reconcile'}
        </TmsButton>
        {summary ? (
          <div style={{ marginTop: 12 }}>
            <p>
              <TmsBadge tone={summary.reconciled ? 'green' : 'orange'}>{summary.reconciled ? 'Reconciled' : 'Differences remain'}</TmsBadge>{' '}
              {!summary.conservationOk ? <TmsBadge tone="red">Outcome counts do not add up</TmsBadge> : null}
            </p>
            <table className="tms-table" data-testid="bridge-table">
              <thead><tr><th>Line</th><th>File</th><th>BCAT</th><th>Difference</th></tr></thead>
              <tbody>
                {summary.bridge.map((l) => (
                  <tr key={l.key}>
                    <td>{l.label}</td><td>{dollars(l.fileCents)}</td><td>{dollars(l.bcatCents)}</td>
                    <td>{l.diffCents == null ? '—' : l.diffCents === 0 ? <TmsBadge tone="green">0</TmsBadge> : <TmsBadge tone="red">{dollars(l.diffCents)}</TmsBadge>}</td>
                  </tr>
                ))}
                <tr><td>Open AR (invoices)</td><td>—</td><td>{dollars(summary.openArCents)}</td><td>—</td></tr>
                <tr><td>Unapplied credit</td><td>—</td><td>{dollars(summary.unappliedCreditCents)}</td><td>—</td></tr>
                <tr><td>Open AP (derived)</td><td>—</td><td>{dollars(summary.openApCents)}</td><td>—</td></tr>
              </tbody>
            </table>
            {Object.keys(summary.findings).length > 0 ? (
              <p className="tms-muted">Findings: {Object.entries(summary.findings).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
            ) : null}
            {summary.memos ? (
              <div data-testid="memo-summary">
                <GroupLabel>AR memos (invoice adjustments)</GroupLabel>
                <p>
                  {summary.memos.total} memos ({summary.memos.credits} credits {dollars(summary.memos.creditCents)}, {summary.memos.debits} debits {dollars(summary.memos.debitCents)}):
                  {' '}{summary.memos.applied} applied to an invoice, {summary.memos.unmatched} with no invoice for their reference.
                </p>
                {summary.memos.unmatchedPros.length > 0 ? (
                  <p className="tms-muted" data-testid="memo-unmatched">Unmatched references (PRO): {summary.memos.unmatchedPros.join(', ')}</p>
                ) : null}
              </div>
            ) : null}
            {summary.warnings && Object.keys(summary.warnings).length > 0 ? (
              <div data-testid="warning-table">
                <GroupLabel>Warnings</GroupLabel>
                <table className="tms-table">
                  <thead><tr><th>Category</th><th>Rows</th><th>Example PROs</th></tr></thead>
                  <tbody>
                    {Object.entries(summary.warnings).map(([cat, w]) => (
                      <tr key={cat}><td>{cat}</td><td>{w.count.toLocaleString('en-US')}</td><td>{w.examplePros.join(', ') || '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {links.length > 0 ? (
              <>
                <GroupLabel>Report files</GroupLabel>
                <ul data-testid="report-links">
                  {links.map((l) => (
                    <li key={l.key}>
                      <a href={l.url} download={l.name}>{l.name === 'import-report.md' ? 'Import report (import-report.md)' : l.name}</a>
                      {l.bytes != null ? <span className="tms-muted"> ({l.bytes.toLocaleString('en-US')} bytes)</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <GroupLabel>Aljex reported totals (optional)</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Open receivables in Aljex ($)"><TmsInput aria-label="Aljex reported open AR" value={reportedAr} onChange={(e) => setReportedAr(e.target.value)} /></TmsField>
              <TmsField label="Open payables in Aljex ($)"><TmsInput aria-label="Aljex reported open AP" value={reportedAp} onChange={(e) => setReportedAp(e.target.value)} /></TmsField>
            </div>
            <table className="tms-table">
              <thead><tr><th>Total</th><th>Aljex</th><th>BCAT</th><th>Difference</th></tr></thead>
              <tbody>
                <Compare label="Open AR" bcat={summary.openArCents} typed={reportedAr} />
                <Compare label="Open AP" bcat={summary.openApCents} typed={reportedAp} />
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <GroupLabel>PRO counter</GroupLabel>
        <Hint>New shipments continue the numeric series above the highest imported PRO. The counter only ever moves forward.</Hint>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <TmsButton size="sm" disabled={busy != null} onClick={() => void previewCounter()}>Preview seed</TmsButton>
          <label>
            <input type="checkbox" aria-label="Switch new shipments to numeric PROs" checked={enableNumeric} onChange={(e) => setEnableNumeric(e.target.checked)} />{' '}
            Switch new shipments to numeric PROs
          </label>
          <TmsButton size="sm" variant="primary" disabled={busy != null || counter == null || !counter.wouldChange} onClick={() => void applyCounter()}>Seed counter</TmsButton>
        </div>
        {counter ? (
          <p data-testid="counter-preview" className="tms-muted">
            Counter is {counter.current ?? 'unset'}; target {counter.target}; {counter.applied ? 'applied' : counter.wouldChange ? 'would change' : 'already at or above the target'}.
            The next new shipment will be {counter.target + 1}.
          </p>
        ) : null}
      </Panel>

      <Panel>
        <GroupLabel>MyCarrierPackets</GroupLabel>
        <Hint>Verifies each imported carrier against MyCarrierPackets. Credentials are entered at Integrations › MyCarrierPackets, never here.</Hint>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <TmsButton size="sm" disabled={busy != null || mcpLive !== true} onClick={() => void sync()}>Sync imported carriers</TmsButton>
          {mcpLive !== true ? (
            <span className="tms-field-hint" data-testid="sync-disabled-reason">
              MyCarrierPackets is not LIVE (Integrations › MyCarrierPackets › Validate).
            </span>
          ) : null}
        </div>
        {syncNote ? <TmsAlert tone="blue">{syncNote}</TmsAlert> : null}
      </Panel>
    </Stack>
  )
}
