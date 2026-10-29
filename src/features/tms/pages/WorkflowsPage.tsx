import { Link } from 'react-router-dom'
import { TmsCard, TmsPage } from '@/features/tms/kit'

/**
 * Workflows is a placeholder in the sidebar until Step K builds it, and this page says so
 * rather than showing an empty board somebody could mistake for a broken one.
 */
export function WorkflowsPage() {
  return (
    <TmsPage title="Workflows">
      <TmsCard title="Not built yet">
        <p>
          Workflows — the errors queue and the AI agents that work it — is Step K of the TMS
          build. Nothing is configured here yet: no rules run, no agent is watching, and
          nothing on this page affects a shipment.
        </p>
        <p style={{ marginTop: 12, color: 'var(--tms-muted)' }}>
          Until then, the exception work lives where it happens: check calls on Shipments,
          carrier uploads under Documents, and the AR and AP ladders under Invoicing.
        </p>
        <p style={{ marginTop: 12 }}>
          <Link to="/tms/academy">Read the Academy</Link> for how each of those queues is
          meant to be worked.
        </p>
      </TmsCard>
    </TmsPage>
  )
}

export default WorkflowsPage
