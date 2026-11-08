/**
 * The `/tms/dashboard` contract (Step R).
 *
 * One shape for the data a card may read, one shape for what a card returns, and one
 * `ChartDef` per card. The Classic cards (`classicCharts.ts`) and the brokerage cards
 * (`brokerageCards.tsx`) are both lists of `ChartDef`, so the page renders them the same
 * way and the chart picker is one list of keys.
 *
 * Honesty rule: a card computes from what the rows actually carry. Where a fact has not
 * been written yet (DAT posting arrives with the Step J integrations), the card says so in
 * `ChartSeries.note` and shows its real zero.
 */
import type { LoadBoardSummary } from '@/lib/apiClient'
import type {
  CarrierBillRecord,
  InvoiceRecord,
  LaneRateSampleRecord,
  LoadCarrierRecord,
  OrderRecord,
  OwnershipDivisionRecord,
  QuoteRecord,
  ShipmentMode,
  ShipmentRecord,
  ShipmentStatus,
  UserProfileRecord,
} from '@/types/tms'

/**
 * A board load, plus the facts the dashboard joins onto it.
 *
 * `listLoadSummaries()` now reads the board columns, the active assignment, the stop
 * list and the mirrored revenue tags; `hydrateLoads` (`src/lib/dashboardCharts.ts`) fills
 * what the read cannot carry — the shipment's customer name, mode, status, DAT stamp and
 * void marker, the ACTIVE leg's carrier id, and the POD / first-ping / check-call facts
 * from this load's rate sample. Every field is real data read from one of those three
 * sources; a load with no leg and no sample simply has `carrierId`/`podReceivedAt` null.
 */
export interface LoadSummaryRecord extends LoadBoardSummary {
  // ── joined from the mirrored Shipment ─────────────────────────────────────
  customerName?: string | null
  mode?: ShipmentMode | null
  datPostedAt?: string | null
  shipmentNumber?: string | null
  shipmentStatus?: ShipmentStatus | null
  voidedAt?: string | null
  // ── joined from the ACTIVE carrier leg ────────────────────────────────────
  carrierId?: string | null
  // ── joined from this load's LaneRateSample (delivered loads only) ─────────
  podReceivedAt?: string | null
  firstPingAt?: string | null
  checkCallsDue?: number | null
  checkCallsMet?: number | null
}

/** The filter row. `from`/`to` are `YYYY-MM-DD` and bound the pickup window. */
export interface DashboardFilters {
  divisions: string[]
  subdivisions: string[]
  from: string
  to: string
  mode: string | null
  status: string | null
  customerId: string | null
  carrierId: string | null
  repId: string | null
}

export type DashboardGroupBy = 'DIVISION' | 'SUBDIVISION' | 'REP' | 'CUSTOMER' | 'CARRIER' | 'STATUS' | 'MONTH'

/** Everything `useBrokerageDashboard` loads for a window. Cards read, never fetch. */
export interface DashboardData {
  shipments: ShipmentRecord[]
  orders: OrderRecord[]
  loads: LoadSummaryRecord[]
  /** The open carrier legs (`listOpenApAssignments`) — the only bulk LoadCarrier read. */
  loadCarriers: LoadCarrierRecord[]
  samples: LaneRateSampleRecord[]
  openInvoices: InvoiceRecord[]
  openBills: CarrierBillRecord[]
  quotes: QuoteRecord[]
  profiles: UserProfileRecord[]
  divisions: OwnershipDivisionRecord[]
  /** ISO instant the bundle was read, so "live" cards age against one clock. */
  now: string
}

export type ChartKind = 'kpis' | 'bar' | 'line' | 'pie' | 'table'

export type ValueFormat = 'count' | 'cents' | 'bps' | 'hours' | 'percent'

/** One column of an explicit table card. `format` overrides the series format. */
export interface ChartColumn {
  key: string
  label: string
  format?: ValueFormat | 'text' | 'date'
}

/** What a card computes: rows × groups, plus how to print the numbers. */
export interface ChartSeries {
  /**
   * Tiles above the chart body. Rendered for every `kind`, so a card can carry both a
   * headline and a chart; `kind: 'kpis'` is a card that carries only tiles.
   */
  kpis?: Array<{ label: string; value: string; sub?: string | null }>
  /** `text` holds the cells a number cannot: a date, a name, a status. */
  rows: Array<{ label: string; values: Record<string, number>; text?: Record<string, string> }>
  /** Legend order; `['total']` when the card is not grouped. */
  groups: string[]
  /**
   * Explicit table columns. When present (`kind: 'table'` only) the table renders the
   * row label first and then one column per entry, reading `text[key]` for the `text`
   * and `date` formats and `values[key]` otherwise. Absent: the groups are the columns.
   */
  columns?: ChartColumn[]
  valueFormat: ValueFormat
  /** Shown under the chart — why a number is what it is, never an excuse for a guess. */
  note?: string | null
}

export interface ChartDef {
  key: string
  title: string
  group: 'classic' | 'brokerage'
  kind: ChartKind
  compute(data: DashboardData, filters: DashboardFilters, groupBy: DashboardGroupBy | null): ChartSeries
}
