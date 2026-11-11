import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsCard } from '@/features/tms/kit'
import { getIntakePdfUrl, rereadIntake } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import type { IntakeLoadRecord } from '@/types/intake'
import './intake.css'

const PARSE_NOTES: Record<string, string> = {
  NOT_PARSED: 'The e-mail was saved but not read automatically',
  FAILED: 'Reading the e-mail failed',
}

/** The attachment the e-mail came with, shown in full beside the form so the load can be built straight from it (Ryne 2026-11-10). */
export function AttachmentPreview({ attachments }: { attachments: IntakeLoadRecord['attachments'] }) {
  const viewable = attachments.filter((a) => /^(application\/pdf|image\/)/.test(a.contentType))
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ key: string; url: string } | { key: string; error: string } | null>(null)
  const active = viewable.find((a) => a.key === activeKey) ?? viewable[0] ?? null
  const activeFile = active?.key ?? null
  useEffect(() => {
    if (!activeFile) return undefined
    let live = true
    getIntakePdfUrl(activeFile)
      .then((url) => { if (live) setLoaded({ key: activeFile, url }) })
      .catch((e: unknown) => { if (live) setLoaded({ key: activeFile, error: e instanceof Error ? e.message : 'Could not load the file' }) })
    return () => { live = false }
  }, [activeFile])
  if (!active) return null
  const shown = loaded?.key === active.key ? loaded : null
  return (
    <div data-testid="intake-attachment-preview" className="tms-intake-preview">
      {viewable.length > 1 ? (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Attachments to preview">
          {viewable.map((a) => (
            <button key={a.key} type="button" role="tab" aria-selected={a.key === active.key} className="tms-empty-action" onClick={() => setActiveKey(a.key)}>{a.name}</button>
          ))}
        </div>
      ) : null}
      {shown && 'url' in shown ? (
        active.contentType.startsWith('image/')
          ? <img src={shown.url} alt={active.name} className="tms-intake-preview-frame" style={{ objectFit: 'contain' }} />
          : <iframe title={active.name} src={shown.url} className="tms-intake-preview-frame" data-testid="intake-preview-frame" />
      ) : shown && 'error' in shown ? <p role="alert">{shown.error}</p> : <p className="tms-muted">Loading {active.name}…</p>}
    </div>
  )
}

/** The tender e-mail as received: who, when, the text and its attachments, plus the link to the agent run. */
export function SourceEmailCard({ row, onReread }: { row: IntakeLoadRecord; onReread?: () => Promise<void> | void }) {
  const [opening, setOpening] = useState<string | null>(null)
  const [reading, setReading] = useState(false)

  async function readNow() {
    setReading(true)
    try {
      await rereadIntake(row.runId)
      await onReread?.()
      toast.success('E-mail read')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read the e-mail')
    } finally {
      setReading(false)
    }
  }

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
          {row.status === 'OPEN' ? (
            <div>
              <TmsButton size="sm" data-testid="intake-reread" disabled={reading} onClick={readNow}>{reading ? 'Reading…' : 'Read the e-mail now'}</TmsButton>
            </div>
          ) : null}
        </TmsAlert>
      ) : null}
      {row.emailLog && row.emailLog.length > 0 ? (
        <div data-testid="intake-email-log" className="text-sm">
          <strong>Repeat e-mails ({row.emailLog.length})</strong>
          <ul>
            {row.emailLog.map((e) => <li key={e.runId}>{formatDateTime(e.at)} · {e.subject}</li>)}
          </ul>
        </div>
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
      <AttachmentPreview attachments={row.attachments} />
      {!row.attachments.some((a) => /^(application\/pdf|image\/)/.test(a.contentType)) ? (
        <TmsAlert tone="orange" title="No rate confirmation PDF on this e-mail" className="tms-intake-banner">
          <span data-testid="intake-no-pdf">
            Nothing viewable came in with it, so there is no PDF to show here. A forward through Slack leaves the attachment behind. The PDF appears on this
            row once the original e-mail (the one the rate confirmation is attached to) comes into Intake through the Ivan Loads mail bridge.
          </span>
        </TmsAlert>
      ) : null}
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
