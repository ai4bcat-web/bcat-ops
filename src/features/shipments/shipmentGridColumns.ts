/**
 * The Shipments lists' columns as dense-grid columns: the R2 catalog (`BOARD_COLUMNS`) with a
 * header filter kind, sort value and alignment per column. Built once; nothing here depends on
 * page state, so the Columns dialog, templates and CSV keep speaking in catalog keys.
 */
import type { DenseColumn, DenseOption } from '@/features/tms/grid/denseGridModel'
import { customerDisplayName } from '@/lib/customerResolution'
import { BOARD_COLUMNS, boardStatusOf, type ShipmentRow } from './shipmentViews'

export function sentence(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

/**
 * The screen and the CSV print the same Status text, because they ask the same
 * column for it. A second copy of this here is how `DEL` ended up on the board
 * beside a checkbox reading `Delivered`.
 */
const STATUS_COLUMN = BOARD_COLUMNS.find((c) => c.key === 'status')
export function statusCellText(row: ShipmentRow): string {
  return STATUS_COLUMN ? STATUS_COLUMN.value(row) : ''
}

/** Facets: a header multi-select instead of a free-text box. */
const MULTI_KEYS = new Set([
  'status', 'customerName', 'carrier', 'revenueType', 'salesRep', 'tracker', 'equip', 'mode', 'arStatus',
  'apStatus', 'driver', 'truck', 'division', 'originState', 'destinationState', 'salesRepId',
])

/** Date columns and the row field each one reads. */
const DATE_FIELDS: Record<string, string> = {
  pickupShip: 'shipDate',
  pickupAppt: 'pickupAppt',
  deliveryAppt: 'deliveryAppt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  lastUpdateAt: 'lastUpdateAt',
  nextCheckCallAt: 'nextCheckCallAt',
  deliveredAt: 'deliveredAt',
}

/** Money and percentage columns: numeric sort and a min/max range. Cents and bps become dollars and percent. */
const NUMBER_FIELDS: Record<string, { value: (row: ShipmentRow) => number | null; unit: string }> = {
  customerTotalRate: { value: (r) => (r.revenueCents == null ? null : r.revenueCents / 100), unit: '$' },
  carrierTotalRates: { value: (r) => (r.costCents == null ? null : r.costCents / 100), unit: '$' },
  grossProfit: { value: (r) => (r.profitCents == null ? null : r.profitCents / 100), unit: '$' },
  netMargin: { value: (r) => (r.marginBps == null ? null : r.marginBps / 100), unit: '%' },
  openIncidentCount: { value: (r) => r.openIncidentCount ?? 0, unit: '' },
}

/** Columns that are controls, not data. */
const NO_FILTER = new Set(['massRelease'])

const BOARD_STATUS_ORDER = ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'DELIVERED', 'HOLD', 'RESERVED', 'VOIDED']

export const STATUS_OPTIONS: DenseOption[] = BOARD_STATUS_ORDER.map((s) => ({ value: s, label: sentence(s) }))

function readField(row: ShipmentRow, field: string): string | null {
  const v = (row as unknown as Record<string, unknown>)[field]
  return typeof v === 'string' && v !== '' ? v : null
}

export const SHIPMENT_GRID_COLUMNS: DenseColumn<ShipmentRow>[] = BOARD_COLUMNS.map((col) => {
  const base: DenseColumn<ShipmentRow> = {
    key: col.key,
    header: col.label,
    text: col.value,
    // The wide catalog width is the *upper* bound of the auto-fit: a dense grid trims to content.
    maxWidth: Math.max(col.width ?? 200, 120) + 60,
    minWidth: 64,
  }
  if (NO_FILTER.has(col.key)) return { ...base, filter: false, sortable: false }
  const number = NUMBER_FIELDS[col.key]
  if (number) {
    return { ...base, filter: 'number', numberOf: number.value, numberUnit: number.unit, align: 'right' }
  }
  const dateField = DATE_FIELDS[col.key]
  if (dateField) return { ...base, filter: 'date', dateOf: (row) => readField(row, dateField) }
  if (col.key === 'status') {
    return {
      ...base,
      filter: 'multi',
      fixedOptions: STATUS_OPTIONS,
      optionsOf: (row) => {
        const status = boardStatusOf(row)
        return [{ value: status, label: sentence(status) }]
      },
      sortValue: statusCellText,
    }
  }
  if (col.key === 'customerName') {
    return { ...base, filter: 'multi', text: customerDisplayName, sortValue: customerDisplayName }
  }
  if (MULTI_KEYS.has(col.key)) return { ...base, filter: 'multi' }
  return base
})

export const SHIPMENT_COLUMN_KEYS = SHIPMENT_GRID_COLUMNS.map((c) => c.key)

/** The Actions column the page appends after the chosen columns. */
export const ACTIONS_COLUMN: DenseColumn<ShipmentRow> = {
  key: 'actions',
  header: '',
  text: () => '',
  fixed: true,
  filter: false,
  sortable: false,
  width: 40,
}
