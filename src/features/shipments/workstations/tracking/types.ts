import type { BoardFilterPanelProps } from '../../board/BoardFilterPanel'
import type { ShipmentRow } from '../../shipmentViews'
import type { RecentShipment } from './useRecentlyViewed'

export type TrackingLifecycle = 'active' | 'pod' | 'closed'

/** One assignee's section of the table; `trackerId` is null for the Unassigned section. */
export interface TrackingGroup {
  key: string
  label: string
  trackerId: string | null
  rows: ShipmentRow[]
}

export interface TrackingAssigneeTab {
  /** 'me' | 'all' | 'unassigned' | a user id. */
  key: string
  label: string
  count: number
  tone?: 'warn'
}

/**
 * The tracking board is the table of every shipment whose rate confirmation went out,
 * grouped by the person tracking it. Row clicks open the shipment's own Tracking tab —
 * the board itself has no detail pane.
 */
export interface TrackingBoardProps {
  groups: TrackingGroup[]
  assigneeTabs: TrackingAssigneeTab[]
  activeAssignee: string
  onSelectAssignee: (key: string) => void
  lifecycle: TrackingLifecycle
  onLifecycle: (value: TrackingLifecycle) => void
  includeUnsent: boolean
  onIncludeUnsent: (value: boolean) => void
  loading: boolean
  error: string | null
  nowMs: number
  mapsKey?: string
  mapsMapId?: string
  query: string
  setQuery: (value: string) => void
  favorites: Set<string>
  onToggleFavorite: (id: string) => void
  onOpenShipment: (id: string) => void
  onCreateShipment: () => void
  onManageLinks: () => void
  onCreateCustomerUrl: (row: ShipmentRow) => void
  onRequestCheckCall: (row: ShipmentRow) => Promise<void>
  onRequestPod: (row: ShipmentRow) => Promise<void>
  onAssignTracker: (shipmentIds: string[], trackerId: string | null) => Promise<void>
  panelProps: BoardFilterPanelProps
  recent: RecentShipment[]
  onOpenRecent: (id: string) => void
  onRemoveRecent: (id: string) => void
}
