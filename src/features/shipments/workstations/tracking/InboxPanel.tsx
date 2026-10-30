/**
 * The Inbox tab — Chaine-style tracking conversations.
 *
 * Left: one row per shipment with traffic (rate-con follow-ups, check calls,
 * location replies, dispatcher e-mails, POD requests and manual messages), newest
 * activity first, searchable by PRO or customer. Right: the shared
 * TrackingConversation, framed here but owned by one module so the Inbox and the
 * shipment's Tracking tab never drift.
 *
 * Selection is presentational: the workstation owns the effective conversation
 * (and the `?shipment=` deep link); this panel only renders it.
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { TmsBadge, TmsEmptyState, TmsInput } from '@/features/tms/kit'
import type { ShipmentMessageRecord } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'
import { relativeTime } from '../motion'
import type { InboxPanelProps } from './types'

function latestAt(messages: ShipmentMessageRecord[]): number {
  let latest = 0
  for (const m of messages) {
    const at = Date.parse(m.at)
    if (Number.isFinite(at) && at > latest) latest = at
  }
  return latest
}

function latestMessage(messages: ShipmentMessageRecord[]): ShipmentMessageRecord | null {
  let latest: ShipmentMessageRecord | null = null
  let latestMs = 0
  for (const m of messages) {
    const at = Date.parse(m.at)
    if (Number.isFinite(at) && at >= latestMs) {
      latestMs = at
      latest = m
    }
  }
  return latest
}

export function InboxPanel({ rows, messagesByShipment, loading, selectedId, onSelect, children }: InboxPanelProps) {
  const [query, setQuery] = useState('')

  const conversations = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .map((row) => ({ row, messages: messagesByShipment[row.id] ?? [] }))
      // The open conversation stays listed even before its first message.
      .filter(({ row, messages }) => messages.length > 0 || row.id === selectedId)
      .filter(({ row }) => {
        if (!q) return true
        return [row.number, row.customerName, row.originCity, row.destinationCity]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q)
      })
      .sort((a, b) => latestAt(b.messages) - latestAt(a.messages))
  }, [rows, messagesByShipment, query, selectedId])

  return (
    <div className="tms-inbox">
      <div className="tms-inbox-list">
        <div className="tms-inbox-list-head">
          <Search size={14} className="tms-tracking-toolbar-icon" />
          <TmsInput
            placeholder="Search conversations..."
            aria-label="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="tms-inbox-items">
          {loading && conversations.length === 0 ? (
            <p className="tms-tracking-empty">Loading conversations…</p>
          ) : conversations.length === 0 ? (
            <p className="tms-tracking-empty">
              {query ? 'No conversations match the search.' : 'No tracking conversations yet.'}
            </p>
          ) : (
            conversations.map(({ row, messages }) => (
              <ConversationRow
                key={row.id}
                row={row}
                messages={messages}
                selected={row.id === selectedId}
                onSelect={() => onSelect(row.id)}
              />
            ))
          )}
        </div>
      </div>
      <div className="tms-inbox-chat">
        {selectedId ? (
          children
        ) : (
          <TmsEmptyState
            title="Select a conversation"
            message="Pick a shipment on the left to read its thread and reply."
          />
        )}
      </div>
    </div>
  )
}

function ConversationRow({
  row,
  messages,
  selected,
  onSelect,
}: {
  row: ShipmentRow
  messages: ShipmentMessageRecord[]
  selected: boolean
  onSelect: () => void
}) {
  const latest = latestMessage(messages)
  const when = relativeTime(latest?.at, Date.now())
  return (
    <button
      type="button"
      className={`tms-inbox-item${selected ? ' tms-active' : ''}`}
      data-testid="inbox-thread-row"
      data-shipment-id={row.id}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="tms-inbox-item-top">
        <span className="tms-inbox-item-pro">{row.number}</span>
        {when && <span className="tms-inbox-item-time">{when}</span>}
      </span>
      <span className="tms-inbox-item-customer">{row.customerName ?? 'Unknown customer'}</span>
      <span className="tms-inbox-item-lane">
        {row.originCity ?? '—'} → {row.destinationCity ?? '—'}
      </span>
      <span className="tms-inbox-item-preview">
        {latest ? latest.body ?? latest.subject ?? '(no body)' : 'No messages yet — start the thread.'}
      </span>
      {messages.length > 0 && (
        <span className="tms-inbox-item-count">
          <TmsBadge tone="blue">{messages.length}</TmsBadge>
        </span>
      )}
    </button>
  )
}
