/**
 * The per-file Aljex imports (customers, carriers, AP aging + expected, AR, active-shipments check): dry run, then apply,
 * for an uploaded and staged file. The server does the work in one request (IMPORT_CUSTOMERS_MASTER / ... ): this panel
 * sends the mode, shows the counts and the review list it returns, and links the report files. Numbers only.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { ErrorText, GroupLabel, Hint, Panel } from '@/features/settings/settingsKit'
import { getAljexReportLinks, runAljexFileImport } from '@/lib/apiClient'
import { FILE_KIND_ACTION, FILE_KIND_LABEL, fileKindOfLayoutId } from '@/lib/aljex/fileKinds'
import type { FileKind } from '@/lib/aljex/fileKinds'
import type { AljexFileImportInput, AljexFileImportResult, AljexImportJob, AljexReportLink, ImportBridgeLine } from '@/types/tms'
import { dollars } from './aljexImportLogic'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const AP_KINDS: readonly FileKind[] = ['AP_AGING', 'AP_EXPECTED']
const USABLE = ['READY', 'PLANNED', 'APPLIED']

/** One level of the numeric summary as label/value rows; `...Cents` keys are shown as dollars. */
function summaryRows(summary: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const show = (key: string, v: unknown): string => (typeof v === 'number' ? (/Cents$/.test(key) ? dollars(v) : v.toLocaleString('en-US')) : String(v))
  for (const [k, v] of Object.entries(summary)) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out.push([k, show(k, v)])
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === 'number' || typeof v2 === 'string') out.push([`${k}.${k2}`, show(k2, v2)])
      }
    }
  }
  return out
}

interface Props {
  job: AljexImportJob
  /** Every job of the list: the AP files pair up (aging + expected). */
  jobs: AljexImportJob[]
  onJob: (job: AljexImportJob) => void
}

export function AljexFileImportPanel({ job, jobs, onJob }: Props) {
  const kind = fileKindOfLayoutId(job.layoutId)
  const [companionId, setCompanionId] = useState('')
  const [cutoff, setCutoff] = useState('')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState<'PLAN' | 'APPLY' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<AljexFileImportResult | null>(null)
  const [links, setLinks] = useState<AljexReportLink[] | null>(null)
  if (!kind) return null

  const ap = AP_KINDS.includes(kind)
  const companionKind: FileKind | null = kind === 'AP_AGING' ? 'AP_EXPECTED' : kind === 'AP_EXPECTED' ? 'AP_AGING' : null
  const companions = companionKind ? jobs.filter((j) => fileKindOfLayoutId(j.layoutId) === companionKind && USABLE.includes(j.status)) : []
  const usable = USABLE.includes(job.status)

  const inputFor = (mode: 'PLAN' | 'APPLY'): AljexFileImportInput => {
    const input: AljexFileImportInput = { mode }
    if (ap) {
      const aging = kind === 'AP_AGING' ? job.id : companionId
      const expected = kind === 'AP_EXPECTED' ? job.id : companionId
      if (aging) input.agingJobId = aging
      if (expected) input.expectedJobId = expected
    } else input.jobId = job.id
    if (cutoff) input.cutoffDate = cutoff
    if (mode === 'APPLY') input.options = { liveTag: tag.trim() }
    return input
  }

  const run = async (mode: 'PLAN' | 'APPLY') => {
    setBusy(mode)
    setError(null)
    try {
      const res = await runAljexFileImport(FILE_KIND_ACTION[kind], inputFor(mode))
      setLast(res)
      setLinks(null)
      onJob(res.job)
      toast.success(mode === 'PLAN' ? 'Dry run finished: nothing was written' : res.rerun ? 'Applied again: nothing new to write' : 'Applied')
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const showFiles = async () => {
    try { setLinks(await getAljexReportLinks(job.id)) } catch (e) { setError(messageOf(e)) }
  }

  const counts = Object.entries(last?.result.counts ?? job.entityCounts ?? {})
  const bridge = (last?.result.reconcile?.bridge ?? []) as ImportBridgeLine[]
  const applyBlock = !usable ? 'Upload and stage the file first.' : job.status === 'READY' ? 'Run the dry run first.' : tag.trim() === '' ? 'Type the live tag to confirm.' : null

  return (
    <Panel>
      <GroupLabel>{FILE_KIND_LABEL[kind]}: dry run, then apply</GroupLabel>
      <p className="tms-muted" data-testid="file-import-job">
        {job.fileName ?? 'file'} · {job.rowCount != null ? `${job.rowCount.toLocaleString('en-US')} rows · ` : ''}
        <TmsBadge tone={job.status === 'APPLIED' ? 'green' : job.status === 'FAILED' ? 'red' : 'gray'}>{job.status}</TmsBadge>
      </p>
      {job.status === 'FAILED' && job.error ? <TmsAlert tone="red" title="The file was refused">{job.error}</TmsAlert> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {companionKind ? (
        <TmsField label={`${FILE_KIND_LABEL[companionKind]} (optional, runs with this one)`}>
          <TmsSelect
            aria-label="Companion AP file"
            value={companionId}
            onChange={(e) => setCompanionId(e.target.value)}
            options={[{ value: '', label: 'None' }, ...companions.map((j) => ({ value: j.id, label: `${j.fileName ?? j.id} (${j.status})` }))]}
          />
        </TmsField>
      ) : null}
      <div className="tms-grid tms-grid-2">
        <TmsField label="Cutoff date (optional)" hint="YYYY-MM-DD; blank uses Settings > Data.">
          <TmsInput aria-label="Cutoff date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} placeholder="2026-11-07" />
        </TmsField>
        <TmsField label="Live tag to apply" hint="Typed to confirm; recorded on the job and in the audit log.">
          <TmsInput aria-label="Live tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. NOV-2026-REHEARSAL" />
        </TmsField>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <TmsButton disabled={!usable || busy != null} onClick={() => void run('PLAN')}>{busy === 'PLAN' ? 'Running…' : 'Dry run'}</TmsButton>
        <TmsButton variant="primary" disabled={applyBlock != null || busy != null} onClick={() => void run('APPLY')}>
          {busy === 'APPLY' ? 'Applying…' : kind === 'ACTIVE_SHIPMENTS' ? 'Save the check report' : 'Apply'}
        </TmsButton>
        {applyBlock ? <span className="tms-field-hint" data-testid="file-apply-block">{applyBlock}</span> : null}
      </div>

      {last ? (
        <div style={{ marginTop: 12 }} data-testid="file-import-result">
          <TmsBadge tone={last.mode === 'PLAN' ? 'turquoise' : 'green'}>{last.mode === 'PLAN' ? 'Dry run' : last.rerun ? 'Applied (again)' : 'Applied'}</TmsBadge>
          {counts.length > 0 ? (
            <table className="tms-table">
              <thead><tr><th>Entity</th><th>Staged</th><th>Create</th><th>Match</th><th>Enrich</th><th>Skip</th><th>Conflict</th><th>Error</th></tr></thead>
              <tbody>
                {counts.map(([entity, c]) => (
                  <tr key={entity}><td>{entity}</td><td>{c.staged}</td><td>{c.created}</td><td>{c.matched}</td><td>{c.enriched}</td><td>{c.skipped}</td><td>{c.conflicts}</td><td>{c.errors}</td></tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <table className="tms-table" data-testid="file-import-summary">
            <tbody>{summaryRows(last.result.summary).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
          {bridge.length > 0 ? (
            <>
              <GroupLabel>Ties to the file (to the cent)</GroupLabel>
              <table className="tms-table">
                <thead><tr><th>Line</th><th>File</th><th>BCAT</th><th>Difference</th></tr></thead>
                <tbody>
                  {bridge.map((b) => (
                    <tr key={b.key}><td>{b.label}</td><td>{dollars(b.fileCents)}</td><td>{dollars(b.bcatCents)}</td><td>{dollars(b.diffCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {last.result.reviewTotal > 0 ? (
            <TmsAlert tone="orange" title={`${last.result.reviewTotal.toLocaleString('en-US')} need a look`}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{last.result.review.slice(0, 20).map((r) => <li key={`${r.key}-${r.reason}`}>{r.key}: {r.reason}</li>)}</ul>
              {last.result.reviewTotal > 20 ? <Hint>The full list is in the report files.</Hint> : null}
            </TmsAlert>
          ) : null}
          <div style={{ marginTop: 8 }}>
            <TmsButton size="sm" onClick={() => void showFiles()}>Report files</TmsButton>
            {links ? <ul>{links.map((l) => <li key={l.key}><a href={l.url}>{l.name}</a></li>)}</ul> : null}
          </div>
        </div>
      ) : null}
    </Panel>
  )
}
