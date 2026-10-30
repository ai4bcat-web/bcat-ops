import type { ReactNode } from 'react'
import type { ShipmentMessageRecord } from '@/types/tms'
import type { BoardFilterPanelProps } from '../../board/BoardFilterPanel'
import type { ShipmentRow } from '../../shipmentViews'
import type { RecentShipment } from './useRecentlyViewed'

/**
 * The tracking board is the Chaine-style table of the filtered shipment set:
 * one row per shipment, a toolbar (search, filters, sort, views, links), the
 * recently-viewed chips and a Table/Map toggle. Row clicks open the shipment's
 * own Tracking tab — the board itself has no detail pane.
 */
export interface TrackingBoardProps {
  rows: ShipmentRow[]
  loading: boolean
  error: string | null
  nowMs: number
  mapsKey?: string
  mapsMapId?: string
  query: string
  setQuery: (value: string) => void
  activeOnly: boolean
  setActiveOnly: (value: boolean) => void
  favorites: Set<string>
  onToggleFavorite: (id: string) => void
  onOpenShipment: (id: string) => void
  onCreateShipment: () => void
  onManageLinks: () => void
  onCreateCustomerUrl: (row: ShipmentRow) => void
  onSaveView: () => void
  panelProps: BoardFilterPanelProps
  recent: RecentShipment[]
  onOpenRecent: (id: string) => void
  onRemoveRecent: (id: string) => void
}

/**
 * The Inbox tab: a Chaine-style conversation list on the left (one row per
 * shipment with traffic), the shared TrackingConversation framed on the right.
 * The workstation composes the right pane so the conversation component stays
 * owned by one module.
 */
export interface InboxPanelProps {
  rows: ShipmentRow[]
  messagesByShipment: Record<string, ShipmentMessageRecord[]>
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  /** The framed conversation for the selected shipment. */
  children?: ReactNode
}
