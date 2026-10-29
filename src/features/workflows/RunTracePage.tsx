/**
 * The run trace as a page, at `/tms/workflows/runs/:id`.
 *
 * The back link points at the Agents tab rather than at browser history: a trace is
 * usually reached from a Slack link or a pasted id, where "back" is nowhere useful.
 */
import { Link, useParams } from 'react-router-dom'
import { TmsPage } from '@/features/tms/kit'
import { RunTrace } from './RunTrace'

export function RunTracePage() {
  const { id } = useParams<{ id: string }>()

  return (
    <TmsPage
      title="Run trace"
      actions={
        <Link className="tms-btn tms-btn-ghost tms-btn-sm" to="/tms/workflows?tab=agents">
          Back to AI Agents
        </Link>
      }
    >
      {id ? <RunTrace runId={id} /> : <p className="tms-muted">No run was named in the link.</p>}
    </TmsPage>
  )
}

export default RunTracePage
