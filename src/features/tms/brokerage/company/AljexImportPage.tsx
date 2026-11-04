/**
 * My Brokerage → Company → Aljex import (owner/ADMIN; CompanyTab gates the route, the Lambda enforces it).
 *
 * A six-step stepper over a server-driven job: File → Profile → Review → Plan → Apply → Reconcile.
 * The file never goes through AppSync: the browser hashes it, reads only its header row to recognise the
 * layout, and PUTs it to a presigned URL. Every gate (unmapped values block, Apply needs a PLANNED job under
 * the saved profile, LIVE needs the typed tag and — for real data — a reconciled rehearsal) lives in
 * `components/aljexImportLogic.ts`; this page only renders the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton } from '@/features/tms/kit'
import { ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'
import {
  applyAljexImport, cancelAljexImport, getAljexImport, getAljexProfile, listAljexImports, pauseAljexImport,
  planAljexImport, prepareAljexImport, resumeAljexImport, sampleAljexImport, saveAljexProfile, stageAljexImport,
} from '@/lib/apiClient'
import { DEFAULT_ALJEX_PROFILE } from '@/lib/aljex/profile'
import type { AljexProfile } from '@/lib/aljex/profile'
import type { AljexImportJob, AljexMappingProfileBody, AljexSampleRow } from '@/types/tms'
import { AljexApplyPanel } from './components/AljexApplyPanel'
import { AljexJobList } from './components/AljexJobList'
import { AljexProfileEditor } from './components/AljexProfileEditor'
import { AljexReconcilePanel } from './components/AljexReconcilePanel'
import {
  STEPS, WORKING_STATUSES, applyBlockReason, blockingOf, detectLayout, furthestStep, naturalStep,
  parseHeaderRecord, planBlockReason, sampleCell, sha256Hex, unmappedFor,
} from './components/aljexImportLogic'
import type { LayoutDetection, StepIndex } from './components/aljexImportLogic'
import { putWithProgress } from './components/uploadFile'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const HEADER_BYTES = 256 * 1024
const POLL_MS = 2500

interface PickedFile {
  file: File
  hash: string
  layout: LayoutDetection
}

export function AljexImportPage() {
  const [jobs, setJobs] = useState<AljexImportJob[]>([])
  const [job, setJob] = useState<AljexImportJob | null>(null)
  const [step, setStep] = useState<StepIndex>(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [reading, setReading] = useState(false)
  const [uploadFraction, setUploadFraction] = useState<number | null>(null)

  const [profile, setProfile] = useState<AljexProfile>(DEFAULT_ALJEX_PROFILE)
  const [savedProfile, setSavedProfile] = useState<AljexProfile>(DEFAULT_ALJEX_PROFILE)
  const [profileVersion, setProfileVersion] = useState<number | null>(null)
  const [plannedProfileVersion, setPlannedProfileVersion] = useState<number | null>(null)

  const [sampleText, setSampleText] = useState('')
  const [sample, setSample] = useState<AljexSampleRow[] | null>(null)
  const [reveal, setReveal] = useState(false)

  const [target, setTarget] = useState<'LIVE' | 'REHEARSAL'>('REHEARSAL')
  const [tag, setTag] = useState('')

  const jobRef = useRef<AljexImportJob | null>(null)
  useEffect(() => { jobRef.current = job }, [job])

  const adopt = useCallback((next: AljexImportJob) => {
    setJob(next)
    setJobs((prev) => [next, ...prev.filter((j) => j.id !== next.id)])
  }, [])

  useEffect(() => {
    let cancelled = false
    listAljexImports()
      .then((rows) => { if (!cancelled) setJobs(rows) })
      .catch((e) => { if (!cancelled) setError(messageOf(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // A worker is moving the job: poll it. Stalled detection needs a clock that ticks even when nothing else does.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(tick)
  }, [])
  const working = job != null && WORKING_STATUSES.includes(job.status)
  const jobId = job?.id ?? null
  useEffect(() => {
    if (!working || jobId == null) return undefined
    let cancelled = false
    const poll = setInterval(() => {
      getAljexImport(jobId)
        .then((next) => { if (!cancelled && jobRef.current?.id === next.id) adopt(next) })
        .catch((e) => { if (!cancelled) setError(messageOf(e)) })
    }, POLL_MS)
    return () => { cancelled = true; clearInterval(poll) }
  }, [working, jobId, adopt])

  // The profile belongs to the layout, not the run: load it whenever a job with a layout is open.
  const layoutId = job?.layoutId ?? picked?.layout.layoutId ?? null
  useEffect(() => {
    if (layoutId == null) return undefined
    let cancelled = false
    getAljexProfile(layoutId)
      .then((row) => {
        if (cancelled) return
        const body = row ? ({ ...DEFAULT_ALJEX_PROFILE, ...(row.profile as unknown as Partial<AljexProfile>) } as AljexProfile) : DEFAULT_ALJEX_PROFILE
        setProfile(body)
        setSavedProfile(body)
        setProfileVersion(row?.version ?? null)
      })
      .catch((e) => { if (!cancelled) setError(messageOf(e)) })
    return () => { cancelled = true }
  }, [layoutId])

  const run = useCallback(async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try { await fn() } catch (e) { setError(messageOf(e)) } finally { setBusy(null) }
  }, [])

  const pick = async (file: File | undefined) => {
    if (!file) return
    setReading(true)
    setError(null)
    setPicked(null)
    try {
      const [head, hash] = await Promise.all([file.slice(0, HEADER_BYTES).text(), file.arrayBuffer().then(sha256Hex)])
      setPicked({ file, hash, layout: detectLayout(parseHeaderRecord(head)) })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setReading(false)
    }
  }

  const upload = () => run('upload', async () => {
    if (!picked) return
    const { file, hash, layout } = picked
    const { job: created, uploadUrl } = await prepareAljexImport({ fileName: file.name, fileHash: hash, sizeBytes: file.size, headerCount: layout.headerCount })
    adopt(created)
    setUploadFraction(0)
    await putWithProgress(uploadUrl, file, setUploadFraction)
    const staging = await stageAljexImport(created.id)
    adopt(staging)
    setUploadFraction(null)
    toast.success('Uploaded. Staging the file…')
  })

  const unmapped = useMemo(() => unmappedFor(profile, job?.stage), [profile, job?.stage])
  const blocking = blockingOf(unmapped)
  const dirty = JSON.stringify(profile) !== JSON.stringify(savedProfile)
  const furthest = furthestStep(job)

  const saveProfile = () => run('profile', async () => {
    if (!job) return
    const row = await saveAljexProfile({
      layoutId: job.layoutId ?? profile.layoutId,
      headerCount: picked?.layout.headerCount,
      profile: profile as unknown as AljexMappingProfileBody,
      expectedVersion: profileVersion,
    })
    const body = { ...DEFAULT_ALJEX_PROFILE, ...(row.profile as unknown as Partial<AljexProfile>) } as AljexProfile
    setSavedProfile(body)
    setProfile(body)
    setProfileVersion(row.version)
    toast.success(`Profile saved (version ${row.version})`)
  })

  const planReason = planBlockReason({ job, blockingUnmapped: blocking.length, profileDirty: dirty })
  const plan = () => run('plan', async () => {
    if (!job) return
    const next = await planAljexImport({ jobId: job.id, options: { expectedRows: job.stage?.rows ?? null } })
    adopt(next)
    setPlannedProfileVersion(profileVersion)
    setStep(3)
  })

  const synthetic = job?.synthetic === true || job?.options?.synthetic === true
  const applyReason = applyBlockReason({
    job, blockingUnmapped: blocking.length, profileDirty: dirty,
    plannedProfileVersion, savedProfileVersion: profileVersion, target, tag, synthetic, rehearsalGate: job?.rehearsalGate,
  })
  const apply = () => run('apply', async () => {
    if (!job) return
    const options = target === 'LIVE'
      ? { target, liveTag: tag.trim(), synthetic, expectedRows: job.stage?.rows ?? null }
      : { target, targetTag: tag.trim(), synthetic, expectedRows: job.stage?.rows ?? null }
    adopt(await applyAljexImport({ jobId: job.id, options }))
  })
  const control = (fn: (id: string) => Promise<AljexImportJob>, name: string) => () => run(name, async () => {
    if (job) adopt(await fn(job.id))
  })

  const loadSample = (unmask: boolean) => run('sample', async () => {
    if (!job) return
    const rows = [...new Set(sampleText.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5)
    setSample(rows.length ? await sampleAljexImport(job.id, rows, unmask) : [])
  })

  const open = (next: AljexImportJob) => {
    setJob(next)
    setStep(naturalStep(next))
    setSample(null)
    setPlannedProfileVersion(null)
    setError(null)
    // The list row can be stale; fetch the job with its stage/plan/gate attached.
    void getAljexImport(next.id).then(adopt).catch((e) => setError(messageOf(e)))
  }

  if (loading) return <Loading />

  const stage = job?.stage ?? null
  const sampleColumns = sample && sample.length ? [...new Set(sample.flatMap((r) => Object.keys(r.fields)))] : []

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={FileUp}
        title="Import from Aljex"
        description="Upload the Aljex full export, check how its values map, review, plan, then apply to a rehearsal copy or live. Nothing is written until Apply."
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}
          <ol className="tms-stepper" style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }} aria-label="Import steps">
            {STEPS.map((label, i) => (
              <li key={label}>
                <TmsButton
                  size="sm"
                  variant={i === step ? 'primary' : undefined}
                  disabled={i > Math.max(furthest, 0) && i !== 0}
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => setStep(i as StepIndex)}
                >
                  {i + 1}. {label}
                </TmsButton>
              </li>
            ))}
          </ol>

          {step === 0 ? (
            <Panel>
              <GroupLabel>File</GroupLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <TmsButton size="sm" disabled={reading} onClick={() => document.getElementById('aljex-import-file')?.click()}>
                  <Upload size={14} /> {reading ? 'Reading…' : 'Choose CSV'}
                </TmsButton>
                <span className="tms-muted">{picked ? picked.file.name : 'No file selected'}</span>
                <input
                  id="aljex-import-file"
                  aria-label="Aljex export file"
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }}
                />
              </div>
              {picked ? (
                <>
                  <p className="tms-field-hint" data-testid="file-hash">SHA-256 {picked.hash.slice(0, 16)}… · {(picked.file.size / 1024 / 1024).toFixed(1)} MB</p>
                  <p data-testid="layout-detection">
                    <TmsBadge tone={picked.layout.matches ? 'green' : 'red'}>{picked.layout.matches ? 'Layout recognised' : 'Layout not recognised'}</TmsBadge>{' '}
                    Aljex full export · {picked.layout.headerCount} columns ·{' '}
                    {picked.layout.matches
                      ? 'matches the saved layout'
                      : `does not match the saved layout (${picked.layout.expectedCount} columns expected${picked.layout.mismatchedColumns.length ? `; columns ${picked.layout.mismatchedColumns.join(', ')} differ` : ''})`}
                  </p>
                  <TmsButton variant="primary" disabled={!picked.layout.matches || busy != null} onClick={() => void upload()}>
                    {busy === 'upload' ? 'Uploading…' : 'Upload and stage'}
                  </TmsButton>
                  {!picked.layout.matches ? <Hint>The importer only reads the layout it knows. Export the full Aljex file again, or ask for a new layout profile.</Hint> : null}
                </>
              ) : null}
              {uploadFraction != null ? (
                <div role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(uploadFraction * 100)} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, background: 'var(--tms-border)', borderRadius: 4, marginTop: 8 }}>
                  <div style={{ width: `${uploadFraction * 100}%`, height: '100%', background: 'var(--tms-primary)' }} />
                </div>
              ) : null}
              {job?.status === 'STAGING' ? <TmsAlert tone="blue">Staging {job.fileName ?? 'the file'}…</TmsAlert> : null}
              {job?.status === 'FAILED' && job.error ? <TmsAlert tone="red" title="Staging failed">{job.error}</TmsAlert> : null}
            </Panel>
          ) : null}

          {step === 1 && job ? (
            <>
              {blocking.length > 0 ? (
                <TmsAlert tone="red" title={`${blocking.length} unmapped value${blocking.length === 1 ? '' : 's'} block the import`}>
                  Map every red row below, then save the profile.
                </TmsAlert>
              ) : null}
              <AljexProfileEditor profile={profile} onChange={setProfile} stage={stage} unmapped={unmapped} disabled={busy != null} />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <TmsButton variant="primary" disabled={!dirty || busy != null} onClick={() => void saveProfile()}>
                  {busy === 'profile' ? 'Saving…' : 'Save profile'}
                </TmsButton>
                <span className="tms-muted" data-testid="profile-version">
                  {dirty ? 'Unsaved changes' : profileVersion != null ? `Saved · version ${profileVersion}` : 'Defaults (not saved yet)'}
                </span>
                <TmsButton disabled={blocking.length > 0 || dirty} onClick={() => setStep(2)}>Continue to Review</TmsButton>
              </div>
            </>
          ) : null}

          {step === 2 && job ? (
            <Panel>
              <GroupLabel>What the file contains</GroupLabel>
              {stage ? (
                <table className="tms-table" data-testid="stage-summary">
                  <tbody>
                    {([
                      ['Rows', stage.rows], ['Loads', stage.loads], ['Memos (DEBT / CRED)', stage.memos], ['Junk dates', stage.junkDates],
                      ['Duplicate PROs', stage.duplicatePros], ['Ragged rows', stage.raggedRows], ['Parse errors', stage.parseErrors],
                    ] as const).map(([label, n]) => <tr key={label}><td>{label}</td><td>{n.toLocaleString('en-US')}</td></tr>)}
                  </tbody>
                </table>
              ) : <p className="tms-muted">No staging summary yet.</p>}
              <GroupLabel>Spot-check up to five rows</GroupLabel>
              <Hint>Enter data-row numbers. Only the fields the importer maps are returned, and values are masked until you reveal them.</Hint>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
                <input className="tms-input" aria-label="Sample row numbers" placeholder="e.g. 12, 400, 8001" value={sampleText} onChange={(e) => setSampleText(e.target.value)} />
                <TmsButton size="sm" disabled={busy != null || sampleText.trim() === ''} onClick={() => void loadSample(reveal)}>Show mapped fields</TmsButton>
                <label>
                  <input
                    type="checkbox"
                    aria-label="Reveal sample values"
                    checked={reveal}
                    onChange={(e) => { setReveal(e.target.checked); if (sample != null) void loadSample(e.target.checked) }}
                  />{' '}
                  Reveal values (fetched unmasked from the server)
                </label>
              </div>
              {sample && sample.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="tms-table" data-testid="sample-table">
                    <thead><tr><th>Row</th>{sampleColumns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {sample.map((r) => (
                        <tr key={r.rowNumber}><td>{r.rowNumber}</td>{sampleColumns.map((c) => <td key={c}>{sampleCell(c, r.fields[c])}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : sample ? <p className="tms-muted">No such rows.</p> : null}
              <div style={{ marginTop: 12 }}><TmsButton variant="primary" onClick={() => setStep(3)}>Continue to Plan</TmsButton></div>
            </Panel>
          ) : null}

          {step === 3 && job ? (
            <Panel>
              <GroupLabel>Plan (dry run: reads the target, writes nothing)</GroupLabel>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <TmsButton variant="primary" disabled={planReason != null || busy != null || job.status === 'PLANNING'} onClick={() => void plan()}>
                  {job.status === 'PLANNING' ? 'Planning…' : job.status === 'PLANNED' ? 'Plan again' : 'Plan'}
                </TmsButton>
                {planReason ? <span className="tms-field-hint" data-testid="plan-block-reason">{planReason}</span> : null}
              </div>
              {job.plan ? (
                <div style={{ marginTop: 12 }}>
                  <p data-testid="plan-classes">
                    {(['CREATE', 'ENRICH', 'UNLINKED', 'CONFLICT'] as const).map((k) => (
                      <span key={k} style={{ marginRight: 12 }}><TmsBadge tone={k === 'CONFLICT' && job.plan!.classes[k] > 0 ? 'red' : 'gray'}>{k}</TmsBadge> {job.plan!.classes[k].toLocaleString('en-US')}</span>
                    ))}
                  </p>
                  {job.plan.warnings.length > 0 ? (
                    <TmsAlert tone="orange" title="Warnings"><ul style={{ margin: 0, paddingLeft: 18 }}>{job.plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul></TmsAlert>
                  ) : null}
                  {Object.keys(job.entityCounts ?? {}).length > 0 ? (
                    <table className="tms-table">
                      <thead><tr><th>Entity</th><th>Staged</th><th>Create</th><th>Match</th><th>Enrich</th><th>Skip</th><th>Conflict</th><th>Error</th></tr></thead>
                      <tbody>
                        {Object.entries(job.entityCounts ?? {}).map(([entity, c]) => (
                          <tr key={entity}><td>{entity}</td><td>{c.staged}</td><td>{c.created}</td><td>{c.matched}</td><td>{c.enriched}</td><td>{c.skipped}</td><td>{c.conflicts}</td><td>{c.errors}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  {job.status === 'PLANNED' ? <div style={{ marginTop: 12 }}><TmsButton variant="primary" onClick={() => setStep(4)}>Continue to Apply</TmsButton></div> : null}
                </div>
              ) : null}
            </Panel>
          ) : null}

          {step === 4 && job ? (
            <AljexApplyPanel
              job={job} now={now} target={target} tag={tag} onTarget={setTarget} onTag={setTag}
              blockReason={applyReason} rehearsalGate={job.rehearsalGate} synthetic={synthetic} busy={busy != null}
              onApply={() => void apply()} onPause={() => void control(pauseAljexImport, 'pause')()}
              onResume={() => void control(resumeAljexImport, 'resume')()} onCancel={() => void control(cancelAljexImport, 'cancel')()}
            />
          ) : null}

          {step === 5 && job ? <AljexReconcilePanel job={job} onJob={adopt} /> : null}
        </Stack>
      </SettingsCard>

      <AljexJobList jobs={jobs} selectedId={job?.id ?? null} now={now} onOpen={open} />
    </div>
  )
}

export default AljexImportPage
