/**
 * Presentational types for the Aljex-style shipments board.
 *
 * The matching logic lives in `src/features/shipments/shipmentViews.ts`; these names are
 * kept identical to the plan so the page can pass the same objects to both layers.
 */
import type {
  BoardStatusKey,
  BoardDetailKey,
  BoardDetailFilter,
  BoardDateFilter,
  BoardFilterSet,
} from '@/types/tms'

export type { BoardStatusKey, BoardDetailKey, BoardDetailFilter, BoardDateFilter, BoardFilterSet }

export type BoardDateKey = 'ship' | 'pickup' | 'delivery' | 'created'

/** One saved view/filter set shown in the panel picker and the top tabs. */
export interface BoardFilterSetOption {
  id: string
  name: string
  shared?: boolean
  isDefault?: boolean
}

/** One saved column template shown in the panel picker. */
export interface BoardColumnTemplateOption {
  id: string
  name: string
  shared?: boolean
}

/** A detail facet the panel can filter on. */
export interface BoardDetailDef {
  key: BoardDetailKey
  label: string
  options: Array<{ value: string; label: string; count: number }>
}
