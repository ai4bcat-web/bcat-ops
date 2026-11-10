import type { EffectiveTrackingPrefs } from '@/lib/trackingPrefs'
import type { ShipmentRow } from '../../shipmentViews'
import type { TrackingFocus } from './trackingTable'

export type TrackingLifecycle = 'active' | 'pod' | 'closed'

export interface TrackingAssigneeTab {
  /** 'me' | 'all' | 'unassigned' | a user id. */
  key: string
  label: string
  count: number
  tone?: 'warn'
}

/**
 * The tracking board is the dense grid of every shipment whose rate confirmation went out,
 * grouped (by default) by the person tracking it. A row click opens the shipment's tracking
 * drawer (`?shipment=`); the board itself has no detail pane.
 */
export interface TrackingBoardProps {
  /** Rows after lifecycle, search and the assignee tab; focus, header filters, sort, group and paging happen in the board. */
  rows: ShipmentRow[]
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
  /** Tracking info for the load (the drawer): a click on the row, or the pin beside the number. */
  onOpenShipment: (id: string) => void
  /** The shipment's own page (the one the Shipments board opens): a click on the shipment number. */
  onOpenShipmentPage?: (id: string) => void
  onCreateShipment: () => void
  /** Narrow to the old worklists: check calls due, documents to review, exceptions. Null = all. */
  focus: TrackingFocus | null
  onFocus: (focus: TrackingFocus | null) => void
  /** `settings.checkCallGraceMinutes`: the same grace the sidebar badge and the notifier use. */
  graceMinutes?: number | null
  /** Resolved tracking prefs of a row; when present the optional "Tracking mode" column exists. */
  prefsOf?: (row: ShipmentRow) => EffectiveTrackingPrefs
  onCreateCustomerUrl: (row: ShipmentRow) => void
  onRequestCheckCall: (row: ShipmentRow) => Promise<void>
  onRequestPod: (row: ShipmentRow) => Promise<void>
  onLogCheckCall: (row: ShipmentRow) => Promise<void>
  onSnooze: (row: ShipmentRow) => Promise<void>
  onReviewDocs: (row: ShipmentRow) => void
  onAssignTracker: (shipmentIds: string[], trackerId: string | null) => Promise<void>
  /** Persists the layout per user. */
  email: string | undefined
  nameOf: (id: string) => string
  /** A lock was let go from the Currently viewing strip: re-read the shipments. */
  onLockReleased?: () => void
}
