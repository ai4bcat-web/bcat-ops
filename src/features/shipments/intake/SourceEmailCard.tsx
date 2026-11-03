import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsAlert, TmsCard } from '@/features/tms/kit'
import { getIntakePdfUrl } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import type { IntakeLoadRecord } from '@/types/intake'
import './intake.css'

const PARSE_NOTES: Record<string, string> = {
  NOT_PARSED: 'The e-mail was saved but not read automatically',
  FAILED: 'Reading the e-mail failed',
}

/** The tender e-mail as received: who, when, the text and its attachments, plus the link to the agent run. */
export function SourceEmailCard({ row }: { row: IntakeLoadRecord }) {
  const [opening, setOpening] = useState<string | null>(null)

  async function open(key: string) {
    setOpening(key)
    try {
      window.open(await getIntakePdfUrl(key), '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the attachment')
    } finally {
      setOpening(null)
    }
  }

  const from = row.fromName ? `${row.fromName} <${row.fromEmail}>` : row.fromEmail
  return (
    <TmsCard title="Source e-mail">
      {row.parseState !== 'PARSED' ? (
        <TmsAlert tone="orange" title={PARSE_NOTES[row.parseState] ?? 'Not parsed'} className="tms-intake-banner">
          {row.parseNote ?? 'Fill the fields below from the e-mail text.'}
        </TmsAlert>
      ) : null}
      <dl className="tms-intake-email-meta">
        <dt className="tms-intake-email-key">From</dt>
        <dd>{from}</dd>
        <dt className="tms-intake-email-key">To</dt>
        <dd>{row.toAddress ?? (row.toAddresses.join(', ') || '—')}</dd>
        <dt className="tms-intake-email-key">Received</dt>
        <dd>{formatDateTime(row.receivedAt)}</dd>
        <dt className="tms-intake-email-key">Subject</dt>
        <dd>{row.subject || '(no subject)'}</dd>
      </dl>
      <div className="tms-intake-email-body" aria-label="E-mail body">{row.bodyText || 'No text in this e-mail.'}</div>
      {row.attachments.length > 0 ? (
        <ul className="tms-intake-attachments" aria-label="Attachments">
          {row.attachments.map((a) => (
            <li key={a.key}>
              <button type="button" className="tms-empty-action" disabled={opening === a.key} onClick={() => open(a.key)}>
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <Link to={`/tms/workflows/runs/${row.runId}`}>Open in Workflows</Link>
      </p>
    </TmsCard>
  )
}

export default SourceEmailCard
