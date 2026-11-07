/**
 * My Brokerage → Company → Data & backups (owner/ADMIN; CompanyTab gates the route, the Lambda enforces it).
 *
 * Backup status (point-in-time recovery, the nightly export), an on-demand S3 export, and "Export everything
 * to CSV": raw per-table dumps plus the four accountant-ready files, so the data is never locked in. The CSVs
 * carry customer and carrier personal data, so starting one needs an acknowledgement, and the all-tables scope
 * needs a typed phrase.
 */
import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { exportNow, getCsvExport, getCsvExportLinks, getDataStatus, listExports, startCsvExport } from '@/lib/apiClient'
import type { DataExportJob, DataExportLinks, DataExportScope, DataStatus } from '@/types/tms'
import { ACTIVE_EXPORT, EXPORT_ALL_PHRASE, bytesLabel, csvExportBlockReason, tablesDone } from './components/dataSafetyLogic'
import { MintShipmentCard } from './components/MintShipmentCard'
import { AljexCutoffCard } from './components/AljexCutoffCard'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const POLL_MS = 3000

function tone(status: DataExportJob['status']): 'green' | 'red' | 'blue' | 'orange' | 'gray' {
  switch (status) {
    case 'COMPLETED': return 'green'
    case 'FAILED': return 'red'
    case 'PARTIAL': return 'orange'
    case 'RUNNING': case 'PENDING': return 'blue'
    default: return 'gray'
  }
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—')

export function DataSafetyPage() {
  const [status, setStatus] = useState<DataStatus | null>(null)
  const [jobs, setJobs] = useState<DataExportJob[]>([])
  const [job, setJob] = useState<DataExportJob | null>(null)
  const [links, setLinks] = useState<DataExportLinks | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<DataExportScope>('TMS')
  const [acknowledgePii, setAcknowledgePii] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([getDataStatus(), listExports()])
    setStatus(s)
    setJobs(list.jobs)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([getDataStatus(), listExports()])
      .then(([s, list]) => { if (!cancelled) { setStatus(s); setJobs(list.jobs) } })
      .catch((e) => { if (!cancelled) setError(messageOf(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const jobId = job?.id ?? null
  const active = job != null && ACTIVE_EXPORT.includes(job.status)
  useEffect(() => {
    if (!active || jobId == null) return undefined
    let cancelled = false
    const poll = setInterval(() => {
      getCsvExport(jobId)
        .then((r) => { if (!cancelled) setJob(r.job) })
        .catch((e) => { if (!cancelled) setError(messageOf(e)) })
    }, POLL_MS)
    return () => { cancelled = true; clearInterval(poll) }
  }, [active, jobId])

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try { await fn() } catch (e) { setError(messageOf(e)) } finally { setBusy(null) }
  }

  const blockReason = csvExportBlockReason({ scope, acknowledgePii, confirmText })

  const startCsv = () => run('csv', async () => {
    setLinks(null)
    const r = await startCsvExport({ scope, acknowledgePii, ...(scope === 'ALL' ? { confirmText } : {}) })
    setJob(r.job)
    toast.success('Export started. You can leave this page; it keeps running.')
  })

  const runNow = () => run('now', async () => {
    const r = await exportNow()
    setJob(r.job)
    await load()
  })

  const openJob = (j: DataExportJob) => run('open', async () => {
    setJob(j)
    setLinks(null)
    if (j.status === 'COMPLETED' || j.status === 'PARTIAL') setLinks(await getCsvExportLinks(j.id))
  })

  const fetchLinks = () => run('links', async () => {
    if (job) setLinks(await getCsvExportLinks(job.id))
  })

  if (loading) return <Loading />

  const progress = job ? tablesDone(job) : null

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={DatabaseBackup}
        title="Data & backups"
        description="Your data is yours. Every table is backed up continuously, exported nightly, and can be downloaded as plain CSV at any time."
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}
          {status ? (
            <Panel>
              <GroupLabel>Backup status</GroupLabel>
              <div className="tms-grid tms-grid-3" data-testid="backup-status">
                <div>
                  <div className="tms-muted">Point-in-time recovery</div>
                  <strong>{status.pitrEnabledCount} of {status.tableCount} tables</strong>{' '}
                  <TmsBadge tone={status.pitrEnabledCount === status.tableCount ? 'green' : 'orange'}>
                    {status.pitrEnabledCount === status.tableCount ? 'All on' : `${status.pitrDisabled.length} off`}
                  </TmsBadge>
                </div>
                <div>
                  <div className="tms-muted">Earliest restorable time</div>
                  <strong>{when(status.earliestRestorableTime)}</strong>
                </div>
                <div>
                  <div className="tms-muted">Nightly export</div>
                  <TmsBadge tone={status.nightlyEnabled ? 'green' : 'gray'}>{status.nightlyEnabled ? 'Scheduled' : 'Not scheduled on this stack'}</TmsBadge>{' '}
                  {status.latestNightly ? <>last {when(status.latestNightly.finishedAt ?? status.latestNightly.startedAt)} <TmsBadge tone={tone(status.latestNightly.status)}>{status.latestNightly.status}</TmsBadge></> : <span className="tms-muted">none yet</span>}
                </div>
              </div>
              {status.pitrDisabled.length > 0 ? <Hint>Without recovery: {status.pitrDisabled.join(', ')}</Hint> : null}
              <p className="tms-muted" style={{ margin: '8px 0 0' }}>
                Copy everything to your own computer: <code data-testid="s3-sync">{status.s3SyncCommand}</code>
              </p>
              <div style={{ marginTop: 12 }}>
                <TmsButton size="sm" disabled={busy != null || active} onClick={() => void runNow()}>
                  {busy === 'now' ? 'Starting…' : 'Run export now'}
                </TmsButton>
              </div>
            </Panel>
          ) : null}

          <Panel>
            <GroupLabel>Export everything to CSV</GroupLabel>
            <Hint>
              One folder per table, a file per ~40 MB, plus four accountant-ready files (invoices, payments, bills, bill payments).
              Files stay private; each Download link expires after 15 minutes.
            </Hint>
            <div className="tms-grid tms-grid-2" style={{ marginTop: 8 }}>
              <TmsField label="Scope">
                <TmsSelect
                  aria-label="Export scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as DataExportScope)}
                  options={[
                    { value: 'TMS', label: 'TMS business data (shipments, customers, carriers, money)' },
                    { value: 'ALL', label: 'ALL tables, including HR, driver and settings data' },
                  ]}
                />
              </TmsField>
              {scope === 'ALL' ? (
                <TmsField label={`Type ${EXPORT_ALL_PHRASE} to confirm`}>
                  <TmsInput aria-label="Confirm export all" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={EXPORT_ALL_PHRASE} />
                </TmsField>
              ) : null}
            </div>
            <label style={{ display: 'block', margin: '8px 0' }}>
              <input type="checkbox" aria-label="Acknowledge personal data" checked={acknowledgePii} onChange={(e) => setAcknowledgePii(e.target.checked)} />{' '}
              These files contain customer, carrier and driver personal information. I will store them securely.
            </label>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <TmsButton variant="primary" disabled={blockReason != null || busy != null || active} onClick={() => void startCsv()}>
                <Download size={14} /> {busy === 'csv' ? 'Starting…' : 'Start CSV export'}
              </TmsButton>
              {blockReason ? <span className="tms-field-hint" data-testid="csv-block-reason">{blockReason}</span> : null}
            </div>
          </Panel>

          {job ? (
            <Panel>
              <GroupLabel>{job.kind} · {job.id}</GroupLabel>
              <p data-testid="export-progress">
                <TmsBadge tone={tone(job.status)}>{job.status}</TmsBadge>{' '}
                {progress && progress.total > 0 ? `${progress.done} of ${progress.total} tables` : 'Starting…'}
                {progress && progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
              </p>
              {job.error ? <TmsAlert tone="red" title="The export failed">{job.error}</TmsAlert> : null}
              {job.tables && job.tables.length > 0 ? (
                <table className="tms-table">
                  <thead><tr><th>Table</th><th>Status</th><th>Rows</th><th>Size</th><th>Files</th></tr></thead>
                  <tbody>
                    {job.tables.map((t) => (
                      <tr key={t.table}>
                        <td>{t.table}{t.pii ? <> <TmsBadge tone="orange">PII</TmsBadge></> : null}</td>
                        <td>{t.status}{t.error ? ` — ${t.error}` : ''}</td>
                        <td>{t.rows?.toLocaleString('en-US') ?? '—'}</td>
                        <td>{bytesLabel(t.bytes)}</td>
                        <td>{t.files ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {job.status === 'COMPLETED' || job.status === 'PARTIAL' ? (
                <div style={{ marginTop: 12 }}>
                  {links ? (
                    <>
                      <p className="tms-muted">Links expire in {Math.round(links.expiresInSeconds / 60)} minutes.</p>
                      {links.manifestUrl ? <p><a href={links.manifestUrl} download="manifest.json">Download manifest</a></p> : null}
                      <ul data-testid="export-files">
                        {links.files.map((f) => (
                          <li key={f.key}><a href={f.url} download={f.name}>{f.name}</a> <span className="tms-muted">{bytesLabel(f.bytes)}</span>{f.pii ? <> <TmsBadge tone="orange">PII</TmsBadge></> : null}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <TmsButton size="sm" disabled={busy != null} onClick={() => void fetchLinks()}>Get download links</TmsButton>
                  )}
                </div>
              ) : null}
            </Panel>
          ) : null}
        </Stack>
      </SettingsCard>
      <AljexCutoffCard />

      <SettingsCard
        icon={DatabaseBackup}
        title="Aljex reconciliation"
        description="Compare the imported Aljex data with the source files, decide every difference and sign off the import."
        actions={<Link className="tms-link" to="/tms/brokerage/company/data/aljex-reconciliation">Open reconciliation</Link>}
      />
      <SettingsCard icon={DatabaseBackup} title="Earlier exports">
        {jobs.length === 0 ? <p className="tms-muted">No exports yet.</p> : (
          <table className="tms-table" data-testid="export-list">
            <thead><tr><th>Kind</th><th>Status</th><th>Scope</th><th>Started</th><th>By</th><th /></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind}</td><td><TmsBadge tone={tone(j.status)}>{j.status}</TmsBadge></td><td>{j.scope ?? '—'}</td>
                  <td>{when(j.startedAt)}</td><td>{j.startedBy ?? '—'}</td>
                  <td><TmsButton size="sm" aria-label={`Open export ${j.id}`} disabled={busy != null} onClick={() => void openJob(j)}>Open</TmsButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>
      <MintShipmentCard />
    </div>
  )
}

export default DataSafetyPage
