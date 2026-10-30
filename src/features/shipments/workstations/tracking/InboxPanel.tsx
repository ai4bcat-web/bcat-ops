import { useMemo, useState } from 'react'
import { Mail, MessageSquare, Phone, StickyNote } from 'lucide-react'
import { TmsBadge, TmsButton, TmsEmptyState } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import type { ShipmentMessageRecord } from '@/types/tms'
import type { InboxPanelProps } from './types'

type InboxSubtab = 'all' | 'chats' | 'notes'

const SUBTAB_ICONS: Record<InboxSubtab, typeof Mail> = {
  all: Mail,
  chats: MessageSquare,
  notes: StickyNote,
}

function partyLabel(m: ShipmentMessageRecord): string {
  if (m.party) return m.party.toLowerCase()
  if (m.direction === 'IN') return 'inbound'
  return 'outbound'
}

function matchesSubtab(m: ShipmentMessageRecord, subtab: InboxSubtab): boolean {
  if (subtab === 'all') return true
  if (subtab === 'notes') return m.kind === 'NOTE' || m.party === 'INTERNAL'
  return m.kind !== 'NOTE' && m.party !== 'INTERNAL'
}

export function InboxPanel({ rows, messagesByShipment, loading, selectedId, onSelect }: InboxPanelProps) {
  const [subtab, setSubtab] = useState<InboxSubtab>('all')

  const shipmentsWithMessages = useMemo(
    () => rows.filter((r) => (messagesByShipment[r.id] ?? []).length > 0),
    [rows, messagesByShipment],
  )

  const selectedShipment = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? shipmentsWithMessages[0] ?? null,
    [rows, selectedId, shipmentsWithMessages],
  )

  const selectedMessages = useMemo(() => {
    if (!selectedShipment) return []
    return (messagesByShipment[selectedShipment.id] ?? []).filter((m) => matchesSubtab(m, subtab))
  }, [selectedShipment, messagesByShipment, subtab])

  return (
    <div className="tms-tracking-inbox">
      <div className="tms-tracking-inbox-head">
        {(['all', 'chats', 'notes'] as InboxSubtab[]).map((key) => {
          const Icon = SUBTAB_ICONS[key]
          return (
            <TmsButton
              key={key}
              size="sm"
              variant={subtab === key ? 'primary' : 'secondary'}
              onClick={() => setSubtab(key)}
              aria-pressed={subtab === key}
            >
              <Icon size={14} />
              {key === 'all' ? 'All messages' : key === 'chats' ? 'Shipment chats' : 'Team notes'}
            </TmsButton>
          )
        })}
      </div>
      <div className="tms-tracking-inbox-body">
        <div className="tms-tracking-inbox-list">
          {loading && !shipmentsWithMessages.length ? (
            <p className="tms-tracking-empty">Loading messages…</p>
          ) : shipmentsWithMessages.length === 0 ? (
            <TmsEmptyState title="No messages" message="Shipment threads appear here once e-mail or SMS traffic exists." />
          ) : (
            shipmentsWithMessages.map((r) => {
              const count = (messagesByShipment[r.id] ?? []).filter((m) => matchesSubtab(m, subtab)).length
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`tms-tracking-inbox-item${selectedShipment?.id === r.id ? ' tms-active' : ''}`}
                  onClick={() => onSelect(r.id)}
                >
                  <span className="tms-tracking-inbox-pro">{r.number}</span>
                  <span className="tms-tracking-inbox-customer">{r.customerName ?? 'Unknown customer'}</span>
                  {count > 0 && <TmsBadge tone="blue">{count}</TmsBadge>}
                </button>
              )
            })
          )}
        </div>
        <div className="tms-tracking-inbox-thread">
          {!selectedShipment ? (
            <TmsEmptyState title="Select a shipment" message="Pick a shipment from the list to read its thread." />
          ) : selectedMessages.length === 0 ? (
            <TmsEmptyState
              title="No thread messages"
              message={`${selectedShipment.number} has no messages in this view.`}
            />
          ) : (
            <div className="tms-tracking-messages">
              <div className="tms-tracking-thread-head">
                <span className="tms-tracking-thread-pro">{selectedShipment.number}</span>
                <span className="tms-tracking-thread-route">
                  {selectedShipment.originCity ?? '—'} → {selectedShipment.destinationCity ?? '—'}
                </span>
              </div>
              {selectedMessages.map((m) => (
                <div key={m.id} className={`tms-tracking-message tms-tracking-message-${m.direction.toLowerCase()}`}>
                  <div className="tms-tracking-message-meta">
                    <TmsBadge tone={m.channel === 'SMS' ? 'turquoise' : m.channel === 'VOICE' ? 'gray' : 'blue'}>
                      {m.channel === 'VOICE' ? <Phone size={10} /> : null}
                      {m.channel}
                    </TmsBadge>
                    <span className="tms-tracking-message-party">{partyLabel(m)}</span>
                    <span className="tms-tracking-message-time">{formatDateTime(m.at)}</span>
                  </div>
                  {m.subject && <p className="tms-tracking-message-subject">{m.subject}</p>}
                  <p className="tms-tracking-message-body">{m.body ?? '(no body)'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
