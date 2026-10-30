import type { CustomerRecord, QuoteRecord, ShipmentBundle, ShipmentMessageRecord, ShipmentPostingRecord, ShipmentRecord, TmsSettings } from '@/types/tms'
import type { CarrierOfferVetting } from '@/lib/apiClient'
import type { CheckCallPlan } from '@/lib/checkCallPlan'
import type { BoardFilterPanelProps } from '../../board/BoardFilterPanel'
import type { ShipmentRow } from '../../shipmentViews'
import type { RecentShipment } from './useRecentlyViewed'

export type TrackingTab = 'inbox' | 'tracking' | 'booking'

export interface OfferWithShipment {
  shipment: ShipmentRecord
  offer: QuoteRecord & { vetting: CarrierOfferVetting }
}

export interface PostingWithShipment {
  posting: ShipmentPostingRecord
  shipment: ShipmentRecord | null
}

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
  mapVisible: boolean
  setMapVisible: (value: boolean) => void
  favorites: Set<string>
  onToggleFavorite: (id: string) => void
  onOpenShipment: (id: string) => void
  onCreateShipment: () => void
  onManageLinks: () => void
  onCreateCustomerUrl: () => void
  onSaveView: () => void
  panelProps: BoardFilterPanelProps
  recent: RecentShipment[]
  onOpenRecent: (id: string) => void
  onRemoveRecent: (id: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  selectedBundle: ShipmentBundle | null
  selectedMessages: ShipmentMessageRecord[]
  detailLoading: boolean
  customers: CustomerRecord[]
  settings: TmsSettings | null
  userName?: string | null
  onSendMessage: (input: {
    channel: 'EMAIL' | 'SMS'
    to: string | null
    subject: string | null
    body: string
  }) => Promise<void>
  onSavePlan: (loadId: string, plan: CheckCallPlan, expectedUpdatedAt?: string) => Promise<void>
  onRefreshDetail: () => void | Promise<void>
}

export interface InboxPanelProps {
  rows: ShipmentRow[]
  messagesByShipment: Record<string, ShipmentMessageRecord[]>
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}

export interface BookingPanelProps {
  rows: ShipmentRow[]
  offersByShipment: Record<string, (QuoteRecord & { vetting: CarrierOfferVetting })[]>
  postings: ShipmentPostingRecord[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onAssign: (shipmentId: string, offerId: string) => void
  onSendSetupPacket: (shipmentId: string, offerId: string) => void
}
