/** Step AG §7.1: the queue's chips and the row's expandable "why". */
import { TmsButton } from '@/features/tms/kit'
import type { ApInboxItemRecord } from '@/lib/apInbox/types'
import { INBOX_CHIPS, REASON_LABEL, SIGNAL_LABEL, VETO_TEXT, pointsText, type InboxChip } from './inboxModel'

const RED = { color: 'var(--tms-badge-red)' }

export function InboxChips({ active, onSelect }: { active: InboxChip; onSelect: (chip: InboxChip) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2" role="group" aria-label="AP inbox status">
      {INBOX_CHIPS.map((c) => (
        <TmsButton
          key={c.key}
          size="sm"
          variant={c.key === active ? 'primary' : 'secondary'}
          data-testid={`ap-inbox-chip-${c.key}`}
          aria-pressed={c.key === active}
          onClick={() => onSelect(c.key)}
        >
          {c.label}
        </TmsButton>
      ))}
    </div>
  )
}

/** The expandable "why": every signal with points, vetoes in red, conflicts, the reader's own words. */
export function ItemWhy({ item, testId }: { item: ApInboxItemRecord; testId: string }) {
  const m = item.match
  const x = item.extraction
  return (
    <details data-testid={testId}>
      <summary className="cursor-pointer text-xs underline">Why</summary>
      <div className="mt-1 space-y-1 text-xs">
        {item.reviewReason && <p><strong>{REASON_LABEL[item.reviewReason] ?? item.reviewReason}</strong></p>}
        {m?.signals.length ? (
          <ul>
            {m.signals.map((s) => (
              <li key={s.key}>{SIGNAL_LABEL[s.key]} <span className="tms-muted tabular-nums">{pointsText(s.points)}</span>{s.detail ? <span className="tms-muted"> — {s.detail}</span> : null}</li>
            ))}
          </ul>
        ) : <p className="tms-muted">No signal tied this e-mail to an open bill.</p>}
        {(m?.top?.vetoes ?? m?.vetoes ?? []).map((v) => <p key={v} style={RED}>{VETO_TEXT[v]}</p>)}
        {item.applied && item.applied.fields.length > 0 && (
          <ul>
            {item.applied.fields.map((f) => (
              <li key={f}>{f}: {String(item.applied?.before[f] ?? '—')} → {String(item.applied?.after[f] ?? '—')}</li>
            ))}
          </ul>
        )}
        {x.reason && <p className="tms-muted">{x.reason}</p>}
        {x.notes && <p className="tms-muted">{x.notes}</p>}
        {x.lowConfidence.length > 0 && <p>Read with low confidence: <u>{x.lowConfidence.join(', ')}</u></p>}
        {x.remitTo?.name && <p className="tms-muted">Remit-to on the e-mail: {x.remitTo.name}</p>}
      </div>
    </details>
  )
}

