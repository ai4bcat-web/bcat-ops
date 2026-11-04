/**
 * Step 5: target + confirmation + live progress. The Apply button's enabled state is exactly
 * `applyBlockReason(...) === null`; the reason is printed beside it so a disabled button explains itself.
 */
import { Pause, Play, RotateCcw, XCircle } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { GroupLabel, Hint, Panel, Stack } from '@/features/settings/settingsKit'
import type { AljexImportJob, AljexRehearsalGate } from '@/types/tms'
import { isStalled, progressOf } from './aljexImportLogic'

export interface AljexApplyPanelProps {
  job: AljexImportJob
  now: number
  target: 'LIVE' | 'REHEARSAL'
  tag: string
  onTarget: (t: 'LIVE' | 'REHEARSAL') => void
  onTag: (tag: string) => void
  /** From `applyBlockReason`; null = the Apply button is enabled. */
  blockReason: string | null
  rehearsalGate: AljexRehearsalGate | null | undefined
  synthetic: boolean
  busy: boolean
  onApply: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

const fmt = (n: number) => n.toLocaleString('en-US')
const eta = (s: number | null) => (s == null ? '—' : s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`)

export function AljexApplyPanel(p: AljexApplyPanelProps) {
  const { job } = p
  const stalled = isStalled(job, p.now)
  const working = job.status === 'RUNNING' && !stalled
  const started = job.status === 'RUNNING' || job.status === 'PAUSED' || job.status === 'APPLIED' || job.status === 'FAILED' || job.status === 'CANCELED'
  const progress = progressOf(job, p.now)

  return (
    <Stack>
      {stalled ? (
        <TmsAlert tone="orange" title="Stalled">
          The worker has not reported for more than 3 minutes. Nothing is lost: the run continues from its last saved cursor.{' '}
          <TmsButton size="sm" variant="primary" disabled={p.busy} onClick={p.onResume}><RotateCcw size={14} /> Resume</TmsButton>
        </TmsAlert>
      ) : null}
      {job.status === 'FAILED' && job.error ? <TmsAlert tone="red" title="The run failed">{job.error}</TmsAlert> : null}

      {!started || job.status === 'PLANNED' ? (
        <Panel>
          <GroupLabel>Where it runs</GroupLabel>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Target">
              <TmsSelect
                aria-label="Import target"
                value={p.target}
                onChange={(e) => p.onTarget(e.target.value as 'LIVE' | 'REHEARSAL')}
                options={[
                  { value: 'REHEARSAL', label: 'REHEARSAL — a throwaway copy of the tables' },
                  { value: 'LIVE', label: 'LIVE — this stack’s real tables' },
                ]}
              />
            </TmsField>
            <TmsField
              label={p.target === 'LIVE' ? 'Type the live tag to confirm' : 'Rehearsal table tag'}
              hint={p.target === 'LIVE' ? 'Recorded on the job and in the audit log.' : 'The copy is <Table>-…-rh<tag>; create it first (scripts/importAljex.mjs rehearsal create).'}
            >
              <TmsInput
                aria-label={p.target === 'LIVE' ? 'Live tag' : 'Rehearsal tag'}
                value={p.tag}
                onChange={(e) => p.onTag(e.target.value)}
                placeholder={p.target === 'LIVE' ? 'e.g. NOV-2026-LIVE' : 'rh1103'}
              />
            </TmsField>
          </div>
          {p.target === 'LIVE' && !p.synthetic ? (
            <p data-testid="rehearsal-gate" style={{ margin: '8px 0 0' }}>
              <TmsBadge tone={p.rehearsalGate?.ok ? 'green' : 'red'}>{p.rehearsalGate?.ok ? 'Rehearsal reconciled' : 'Rehearsal required'}</TmsBadge>{' '}
              <span className="tms-muted">
                {p.rehearsalGate?.ok
                  ? 'A reconciled rehearsal of this file and profile exists.'
                  : p.rehearsalGate?.reason ?? 'Real data goes LIVE only after a RECONCILED rehearsal of the same file and profile.'}
              </span>
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <TmsButton variant="primary" disabled={p.blockReason != null || p.busy} onClick={p.onApply}>
              <Play size={14} /> {p.busy ? 'Starting…' : `Apply to ${p.target === 'LIVE' ? 'LIVE' : 'rehearsal copy'}`}
            </TmsButton>
            {p.blockReason ? <span className="tms-field-hint" data-testid="apply-block-reason">{p.blockReason}</span> : null}
          </div>
        </Panel>
      ) : null}

      {started ? (
        <Panel>
          <GroupLabel>Progress</GroupLabel>
          <div
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent ?? 0}
            style={{ height: 10, borderRadius: 5, background: 'var(--tms-border)', overflow: 'hidden' }}
          >
            <div style={{ width: `${progress.percent ?? 0}%`, height: '100%', background: 'var(--tms-primary)' }} />
          </div>
          <p className="tms-muted" data-testid="apply-progress" style={{ margin: '8px 0 0' }}>
            <TmsBadge tone={stalled ? 'orange' : job.status === 'FAILED' ? 'red' : job.status === 'APPLIED' ? 'green' : 'blue'}>{stalled ? 'Stalled' : job.status}</TmsBadge>{' '}
            Phase {progress.phaseIndex}/{progress.phaseCount} · {progress.phaseLabel} · {fmt(progress.done)} of {fmt(progress.staged)} rows
            {progress.percent != null ? ` (${progress.percent}%)` : ''}
            {progress.rowsPerSecond != null ? ` · ${progress.rowsPerSecond.toFixed(1)} rows/s · ETA ${eta(progress.etaSeconds)}` : ''}
          </p>
          <table className="tms-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Entity</th><th>Staged</th><th>Created</th><th>Matched</th><th>Enriched</th><th>Skipped</th><th>Conflicts</th><th>Errors</th></tr></thead>
            <tbody>
              {Object.entries(job.entityCounts ?? {}).map(([entity, c]) => (
                <tr key={entity}>
                  <td>{entity}</td><td>{fmt(c.staged)}</td><td>{fmt(c.created)}</td><td>{fmt(c.matched)}</td>
                  <td>{fmt(c.enriched)}</td><td>{fmt(c.skipped)}</td><td>{fmt(c.conflicts)}</td><td>{fmt(c.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <TmsButton size="sm" disabled={!working || p.busy} onClick={p.onPause}><Pause size={14} /> Pause</TmsButton>
            <TmsButton size="sm" disabled={job.status !== 'PAUSED' || p.busy} onClick={p.onResume}><Play size={14} /> Resume</TmsButton>
            <TmsButton size="sm" disabled={!(job.status === 'RUNNING' || job.status === 'PAUSED') || p.busy} onClick={p.onCancel}><XCircle size={14} /> Cancel</TmsButton>
          </div>
          <Hint>Pause finishes the current batch. Cancel stops further phases; nothing already written is deleted.</Hint>
        </Panel>
      ) : null}
    </Stack>
  )
}
