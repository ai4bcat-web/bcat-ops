/**
 * Inbox chat header: "Chat with {driver}", truck chip, PRO link, and a contact row
 * with the last-ping freshness dot, call link and the Info panel toggle.
 * There is no presence data, so nothing here says "online" — only when we last heard.
 */
import { Info, Phone, Truck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TmsAvatar, TmsBadge } from '@/features/tms/kit'
import type { LoadCarrierRecord } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'
import { relativeTime } from '../motion'
import { isFreshPing } from './statusTimeline'

export interface InboxChatHeaderProps {
  row: Pick<ShipmentRow, 'id' | 'number'>
  leg: LoadCarrierRecord | null
  pingAt: string | null
  nowMs: number
  infoOpen: boolean
  onToggleInfo: () => void
}

export function InboxChatHeader({ row, leg, pingAt, nowMs, infoOpen, onToggleInfo }: InboxChatHeaderProps) {
  const driverName = leg?.driverName?.trim() || null
  const ping = relativeTime(pingAt, nowMs)
  const fresh = isFreshPing(pingAt, nowMs)
  return (
    <header className="tms-chat-header" data-testid="inbox-chat-header">
      <div className="tms-chat-header-title">
        <h2 className="tms-chat-header-name">Chat with {driverName ?? 'driver'}</h2>
        {leg?.truckNumber && (
          <TmsBadge tone="gray"><Truck size={11} aria-hidden /> Truck {leg.truckNumber}</TmsBadge>
        )}
        <Link className="tms-chat-header-pro" to={`/tms/shipments/${row.id}`}>PRO {row.number}</Link>
      </div>
      <div className="tms-chat-header-contact">
        <TmsAvatar label={driverName ?? 'Driver'} size="sm" />
        <div className="tms-chat-header-who">
          <span className="tms-chat-header-person">{driverName ?? 'No driver on file'}</span>
          <span className="tms-chat-header-ping" data-testid="inbox-last-ping" data-fresh={fresh ? 'true' : 'false'}>
            <span className="tms-ping-dot" aria-hidden />
            {pingAt && ping ? `Last ping ${ping}` : 'No ping yet'}
          </span>
        </div>
        <div className="tms-chat-header-actions">
          {leg?.driverPhone && (
            <a className="tms-icon-link" href={`tel:${leg.driverPhone}`} aria-label={`Call ${driverName ?? 'driver'}`} title={`Call ${leg.driverPhone}`}>
              <Phone size={16} aria-hidden />
            </a>
          )}
          <button
            type="button"
            className="tms-icon-link"
            aria-label="Shipment info"
            aria-pressed={infoOpen}
            title={infoOpen ? 'Hide info panel' : 'Show info panel'}
            onClick={onToggleInfo}
          >
            <Info size={16} aria-hidden />
          </button>
        </div>
      </div>
    </header>
  )
}
