/**
 * Platform health (owner/ADMIN): are the integrations connected, is anything failing,
 * when did the background jobs last run, and what build is this. It reads state the
 * rest of the app already owns and decides nothing itself — grading lives in
 * `lib/platformHealth`, the badges in `lib/integrations/health`.
 */
import { Activity, AlertTriangle, Plug, Rocket } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  TmsAlert, TmsButton, TmsCard, TmsKpiCard, TmsScrollPage,
} from '@/features/tms/kit'
import { formatAge } from '@/lib/platformHealth'
import { DeployCard } from './DeployCard'
import { IntegrationsPanel } from './IntegrationsPanel'
import { SyncTable } from './SyncTable'
import { usePlatformHealth } from './usePlatformHealth'

const ERRORS_TAB = '/tms/workflows?tab=errors'

export function PlatformHealthPage() {
  const navigate = useNavigate()
  const health = usePlatformHealth()
  const { build, summary, nowMs } = health

  const builtAge = build.builtAt ? formatAge(Math.max(0, nowMs - Date.parse(build.builtAt))) : null
  const deploySub = [
    build.jobId ? `job ${build.jobId}` : null,
    build.commit ? build.commit.slice(0, 7) : null,
    build.branch,
  ].filter(Boolean).join(' · ')
  const loaded = !health.integrationsLoading

  return (
    <TmsScrollPage
      title="Platform health"
      subtitle="Integrations, background jobs, workflow errors and the running build."
      actions={<TmsButton onClick={() => void health.refresh()}>Refresh</TmsButton>}
    >
      <div className="tms-stack">
        {build.isDev ? (
          <TmsAlert tone="blue" title="Dev stack">
            Background schedules are disabled here and outbound mail is blocked, so sync times read stale by design.
            Secrets the dev stack neutered are not counted as failures.
          </TmsAlert>
        ) : null}
        {health.integrationsError ? <TmsAlert tone="red">{health.integrationsError}</TmsAlert> : null}
        {health.recheckError ? <TmsAlert tone="red" title="Re-check failed">{health.recheckError}</TmsAlert> : null}

        <div className="tms-grid tms-grid-4">
          <TmsKpiCard
            label="Integrations connected"
            icon={Plug}
            value={loaded ? `${summary.connected} of ${summary.total}` : null}
          />
          <TmsKpiCard
            label="Needs attention"
            icon={AlertTriangle}
            value={loaded ? String(summary.needsAttention) : null}
            tone={loaded && summary.needsAttention > 0 ? 'bad' : 'default'}
            sub={loaded ? `${summary.neuteredOnDev} neutered on dev` : null}
          />
          <TmsKpiCard
            label="Open workflow errors"
            icon={Activity}
            value={health.errorsLoading ? null : String(health.errorRuns.length)}
            tone={health.errorRuns.length > 0 ? 'warn' : 'default'}
            onClick={() => navigate(ERRORS_TAB)}
            sub="Open the Errors tab"
          />
          <TmsKpiCard
            label="Deployed"
            icon={Rocket}
            value={builtAge}
            sub={deploySub || 'Build info not recorded'}
          />
        </div>

        <IntegrationsPanel
          entries={summary.entries}
          loading={health.integrationsLoading}
          recheckingKey={health.recheckingKey}
          onRecheck={(provider) => void health.recheck(provider)}
        />

        <TmsCard
          title="Workflow errors"
          actions={<TmsButton size="sm" onClick={() => navigate(ERRORS_TAB)}>Open Errors tab</TmsButton>}
        >
          {health.errorsError ? <p className="tms-field-error">{health.errorsError}</p> : null}
          {health.errorRuns.length === 0 ? (
            <p className="tms-muted">{health.errorsLoading ? 'Loading…' : 'No open workflow errors.'}</p>
          ) : (
            <>
              <p className="tms-muted">
                {health.errorGroups.map((g) => `${g.agent}: ${g.count}`).join(' · ')}
              </p>
              <ul>
                {health.errorsNewest.map((run) => {
                  const at = run.receivedAt ?? run.updatedAt ?? run.createdAt ?? null
                  const age = at ? formatAge(Math.max(0, nowMs - Date.parse(at))) : null
                  return (
                    <li key={run.id}>
                      {run.subject?.trim() || run.errorCode || run.sourceId}
                      {age ? <span className="tms-muted"> · {age}</span> : null}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </TmsCard>

        <SyncTable rows={health.sync} />

        <DeployCard build={build} updateAvailable={health.updateAvailable} onReload={health.reload} />
      </div>
    </TmsScrollPage>
  )
}

export default PlatformHealthPage
