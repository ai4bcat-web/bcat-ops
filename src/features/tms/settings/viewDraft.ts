/**
 * The half-written state behind Shipment views.
 *
 * A view's `filters` is the object `applyViewFilters` reads on the Shipments board,
 * so the editor never saves an empty clause: an absent key filters nothing, while
 * `{ statuses: [] }` would read as a clause nobody wrote. `draftToViewInput` is the
 * one place that decides what counts as written.
 */
import { slugify } from '@/lib/shipmentViewDefs'
import type { ShipmentViewInput } from '@/lib/apiClient'
import type {
  ApStatus,
  ArStatus,
  ShipmentStatus,
  ShipmentViewCarrierType,
  ShipmentViewDocsState,
  ShipmentViewFilters,
  ShipmentViewPickupWindow,
  ShipmentViewRecord,
  ShipmentViewTrackingState,
} from '@/types/tms'

export const PICKUP_WINDOWS: ReadonlyArray<{ value: ShipmentViewPickupWindow; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'today_tomorrow', label: 'Today or tomorrow' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_30_days', label: 'Last 30 days' },
]

export const CARRIER_TYPES: ReadonlyArray<{ value: ShipmentViewCarrierType; label: string }> = [
  { value: 'OWN_FLEET', label: 'Own fleet' },
  { value: 'CARRIER', label: 'Outside carrier' },
  { value: 'NEED_TO_COVER', label: 'Needs covering' },
]

export const DOCS_STATES: ReadonlyArray<{ value: ShipmentViewDocsState; label: string }> = [
  { value: 'POD_MISSING', label: 'POD missing' },
  { value: 'DOCS_NEEDED', label: 'Documents missing' },
  { value: 'COMPLETE', label: 'Documents complete' },
]

export const TRACKING_STATES: ReadonlyArray<{ value: ShipmentViewTrackingState; label: string }> = [
  { value: 'TRACKED', label: 'Tracked' },
  { value: 'UNTRACKED', label: 'Not tracked' },
  { value: 'OVERDUE', label: 'Check call overdue' },
]

export const AR_STATUSES: readonly ArStatus[] = ['DOCS_NEEDED', 'UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED', 'LEGACY']
export const AP_STATUSES: readonly ApStatus[] = ['AWAITING_INVOICE', 'IN_REVIEW', 'TO_BE_PAID', 'PAID']

/** Every clause the editor can set. `''` and `[]` mean "not written". */
export interface ViewFilterDraft {
  divisions: string[]
  subdivisions: string[]
  statuses: ShipmentStatus[]
  carrierType: ShipmentViewCarrierType | ''
  repId: string
  pickupWindow: ShipmentViewPickupWindow | ''
  docsState: ShipmentViewDocsState | ''
  trackingState: ShipmentViewTrackingState | ''
  arStatuses: ArStatus[]
  apStatuses: ApStatus[]
  quoteToBooked: boolean
  search: string
}

export interface ViewDraft {
  /** The slug, and therefore the id. Null until the view has been saved once. */
  id: string | null
  name: string
  department: string
  description: string
  isDefault: boolean
  sortOrder: number
  active: boolean
  audienceRoles: string[]
  audienceGroups: string[]
  audienceDivisions: string[]
  filters: ViewFilterDraft
  columns: string[]
  sortKey: string
  sortDir: 'asc' | 'desc'
}

const EMPTY_FILTERS: ViewFilterDraft = {
  divisions: [],
  subdivisions: [],
  statuses: [],
  carrierType: '',
  repId: '',
  pickupWindow: '',
  docsState: '',
  trackingState: '',
  arStatuses: [],
  apStatuses: [],
  quoteToBooked: false,
  search: '',
}

export function blankViewDraft(columns: readonly string[], sortOrder = 0): ViewDraft {
  return {
    id: null,
    name: '',
    department: '',
    description: '',
    isDefault: false,
    sortOrder,
    active: true,
    audienceRoles: [],
    audienceGroups: [],
    audienceDivisions: [],
    filters: { ...EMPTY_FILTERS },
    columns: [...columns],
    sortKey: '',
    sortDir: 'asc',
  }
}

export function viewToDraft(view: ShipmentViewRecord, fallbackColumns: readonly string[]): ViewDraft {
  const f = view.filters ?? {}
  return {
    id: view.slug || view.id,
    name: view.name,
    department: view.department ?? '',
    description: view.description ?? '',
    isDefault: view.isDefault,
    sortOrder: view.sortOrder,
    active: view.active,
    audienceRoles: view.audience?.roles ?? [],
    audienceGroups: view.audience?.groups ?? [],
    audienceDivisions: view.audience?.divisions ?? [],
    filters: {
      divisions: f.divisions ?? [],
      subdivisions: f.subdivisions ?? [],
      statuses: f.statuses ?? [],
      carrierType: f.carrierType ?? '',
      repId: f.repId ?? '',
      pickupWindow: f.pickupWindow ?? '',
      docsState: f.docsState ?? '',
      trackingState: f.trackingState ?? '',
      arStatuses: f.arStatuses ?? [],
      apStatuses: f.apStatuses ?? [],
      quoteToBooked: f.quoteToBooked === true,
      search: f.search ?? '',
    },
    columns: view.columns?.length ? [...view.columns] : [...fallbackColumns],
    sortKey: view.sort?.key ?? '',
    sortDir: view.sort?.dir ?? 'asc',
  }
}

/** The slug a draft would be saved under — shown live under the name field. */
export function draftSlug(draft: ViewDraft): string {
  return draft.id ?? slugify(draft.name)
}

/** Only the clauses somebody actually wrote. */
export function draftFilters(draft: ViewDraft): ShipmentViewFilters {
  const f = draft.filters
  const filters: ShipmentViewFilters = {}
  if (f.divisions.length) filters.divisions = [...f.divisions]
  if (f.subdivisions.length) filters.subdivisions = [...f.subdivisions]
  if (f.statuses.length) filters.statuses = [...f.statuses]
  if (f.carrierType) filters.carrierType = f.carrierType
  if (f.repId.trim()) filters.repId = f.repId.trim()
  if (f.pickupWindow) filters.pickupWindow = f.pickupWindow
  if (f.docsState) filters.docsState = f.docsState
  if (f.trackingState) filters.trackingState = f.trackingState
  if (f.arStatuses.length) filters.arStatuses = [...f.arStatuses]
  if (f.apStatuses.length) filters.apStatuses = [...f.apStatuses]
  if (f.quoteToBooked) filters.quoteToBooked = true
  if (f.search.trim()) filters.search = f.search.trim()
  return filters
}

export function draftToViewInput(draft: ViewDraft): ShipmentViewInput {
  const slug = draftSlug(draft)
  const audience = {
    ...(draft.audienceGroups.length ? { groups: [...draft.audienceGroups] } : {}),
    ...(draft.audienceRoles.length ? { roles: [...draft.audienceRoles] } : {}),
    ...(draft.audienceDivisions.length ? { divisions: [...draft.audienceDivisions] } : {}),
  }
  return {
    id: slug,
    slug,
    name: draft.name.trim(),
    department: draft.department.trim() || null,
    description: draft.description.trim() || null,
    filters: draftFilters(draft),
    columns: draft.columns.length ? [...draft.columns] : null,
    sort: draft.sortKey ? { key: draft.sortKey, dir: draft.sortDir } : null,
    isDefault: draft.isDefault,
    audience: Object.keys(audience).length ? audience : null,
    sortOrder: draft.sortOrder,
    active: draft.active,
  }
}
