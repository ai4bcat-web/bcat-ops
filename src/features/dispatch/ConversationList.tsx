import { Phone, Voicemail, Image as ImageIcon, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDrivers } from '@/hooks/useDrivers'
import { conversationColor, initialsOf } from './conversationColor'
import { conversationTitle, prettyPhone, type DispatchConversation } from '@/lib/dispatch'
import { listTime, staffName } from './dispatchUi'

interface Props {
  rows: DispatchConversation[]
  selectedId: string | null
  onSelect: (id: string) => void
  now: Date
}

function KindIcon({ kind }: { kind: string | null | undefined }) {
  const cls = 'size-3.5 shrink-0'
  if (kind === 'CALL') return <Phone className={cls} />
  if (kind === 'VOICEMAIL') return <Voicemail className={cls} />
  if (kind === 'MMS') return <ImageIcon className={cls} />
  if (kind === 'NOTE') return <StickyNote className={cls} />
  return null
}

export function ConversationList({ rows, selectedId, onSelect, now }: Props) {
  const { drivers } = useDrivers()
  if (rows.length === 0) {
    return <div style={{ padding: 24, fontSize: 13, color: 'var(--ds-t3)', textAlign: 'center' }}>No conversations here.</div>
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((c) => {
        const unread = (c.unreadCount ?? 0) > 0
        const active = c.id === selectedId
        const title = conversationTitle(c)
        const isDriver = !!c.driverId
        const color = conversationColor(c, drivers)
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              aria-current={active ? 'true' : undefined}
              className={cn('w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-blue)]')}
              style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr auto', gridTemplateRows: 'auto auto', gap: '2px 10px', padding: '10px 12px 10px 10px',
                background: active ? color.bg : 'transparent',
                borderBottom: '1px solid var(--ds-border-soft)', borderLeft: `4px solid ${color.border}`,
                cursor: 'pointer',
              }}
            >
              <span aria-hidden="true" style={{ gridRow: '1 / span 2', alignSelf: 'center', width: 34, height: 34, borderRadius: 17, background: color.avatarBg, color: '#fff', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: unread ? `0 0 0 2px ${color.border}` : 'none' }}>{initialsOf(title)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: unread ? 700 : 600, color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                {isDriver ? <span style={{ fontSize: 11, color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{prettyPhone(c.phone)}</span> : null}
                {c.status === 'ARCHIVED' ? <span style={{ fontSize: 10, color: 'var(--ds-t3)', border: '1px solid var(--ds-border)', borderRadius: 4, padding: '0 4px' }}>Archived</span> : null}
              </span>
              <span style={{ fontSize: 11, color: unread ? color.border : 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{listTime(c.lastMessageAt, now)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, fontSize: 12, color: unread ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>
                <KindIcon kind={c.lastKind} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.lastDirection === 'OUT' && c.lastKind !== 'NOTE' ? `${staffName(c.lastSentBy) || 'Sent'}: ` : ''}{c.lastPreview ?? (isDriver ? prettyPhone(c.phone) : 'New conversation')}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                {c.assignedTo ? <span title={c.assignedTo} style={{ fontSize: 10, color: 'var(--ds-t3)', background: 'var(--ds-bg-2)', borderRadius: 4, padding: '1px 5px' }}>{staffName(c.assignedTo)}</span> : null}
                {unread ? <span style={{ minWidth: 18, height: 18, borderRadius: 9, background: color.border, color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{c.unreadCount}</span> : null}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
