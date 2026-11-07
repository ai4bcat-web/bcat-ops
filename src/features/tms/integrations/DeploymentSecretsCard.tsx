/**
 * "Deployment secrets": present / missing by NAME, never a value. Amplify secrets are
 * set with one command; page credentials are typed on their provider page and are
 * write-only there.
 */
import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import type { IntegrationRecord } from '@/lib/integrations/types'
import { deploymentSecretStatuses } from './deploymentSecrets'
import type { SecretState } from './deploymentSecrets'
const BADGE: Record<SecretState, { tone: 'green' | 'red' | 'orange' | 'gray'; label: string }> = {
  PRESENT: { tone: 'green', label: 'Present' },
  MISSING: { tone: 'red', label: 'Missing' },
  NEUTERED: { tone: 'orange', label: 'Neutered on dev' },
  UNKNOWN: { tone: 'gray', label: 'Not reported' },
}

export function DeploymentSecretsCard({ byKey }: { byKey: Record<string, IntegrationRecord | undefined> }) {
  const entries = deploymentSecretStatuses(byKey)
  return (
    <div className="tms-card" data-testid="deployment-secrets">
      <div className="tms-card-head"><h3>Deployment secrets</h3></div>
      <div className="tms-card-body">
        <p className="tms-muted">
          Names only: values are never shown. Amplify secrets are set once with the command; provider credentials are typed on the provider page and cannot be read back.
        </p>
        <ul>
          {entries.map((entry) => (
            <li key={entry.name}>
              <code>{entry.name}</code>{' '}
              <TmsBadge tone={BADGE[entry.state].tone}>{BADGE[entry.state].label}</TmsBadge>
              {entry.kind === 'PAGE' && entry.missing.length ? <> (needs {entry.missing.join(', ')})</> : null}
              <div className="tms-muted">{entry.feeds} {entry.note}</div>
              {entry.kind === 'STACK'
                ? <div>Run: <code>{entry.action}</code></div>
                : <div><Link to={entry.route}>{entry.action}</Link></div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
