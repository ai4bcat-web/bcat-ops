/**
 * Load Tracking's columns as dense-grid columns: the text each cell prints, how it sorts and which
 * header filter it carries (type-ahead for text, multi-select for status / customer / carrier /
 * tracker / POD, date range for appointments and ETA, numeric range for ping age and next check).
 * The JSX of each cell stays in TrackingBoard; this file is pure so the filters and sorts are
 * testable without rendering.
 */
import type { DenseColumn, DenseOption } from '@/features/tms/grid/denseGridModel'
import { formatBoardDateTime } from '@/lib/date'
import { CHECK_CALL_TYPE_LABELS } from '@/lib/checkCalls'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { EffectiveTrackingPrefs, TrackingMethod } from '@/lib/trackingPrefs'
import { boardStatusOf, type BoardStatusKey, type ShipmentRow } from '../../shipmentViews'
import { motionOf, relativeTime } from '../motion'
import { nextEventText } from './nextEventText'
import {
  UNASSIGNED_KEY,
  hasDocsToReview,
  hasException,
  durationText,
  etaOf,
  nextCheckCallStateOf,
  podStateOf,
  type PodState,
} from './trackingTable'

export const POD_LABELS: Record<Exclude<PodState, 'NOT_DUE'>, string> = {
  NEEDED: 'POD needed',
  REQUESTED: 'Requested',
  IN_REVIEW: 'In review',
  RECEIVED: 'Received',
  UNKNOWN: 'Not checked',
}

const STATUS_ORDER: Record<string, number> = {
  OPEN: 1, COVERED: 2, DISPATCHED: 3, ARRIVED: 4, DEPARTED: 5, DELIVERED: 6, HOLD: 7, RESERVED: 8, VOIDED: 9,
}

const STATUS_KEYS: Array<BoardStatusKey | 'CANCELED'> = [
  'OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'DELIVERED', 'HOLD', 'RESERVED', 'VOIDED', 'CANCELED',
]

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase()
}

export function statusOptionOf(row: ShipmentRow): DenseOption {
  const status = boardStatusOf(row)
  return { value: status, label: titleCase(status) }
}

export function motionText(row: ShipmentRow, nowMs: number): string {
  return motionOf({
    lastUpdateAt: row.lastUpdateAt,
    lastUpdatePlace: row.lastUpdatePlace,
    previousUpdateAt: row.previousUpdateAt ?? row.lastKnownAt,
    previousUpdatePlace: row.previousUpdatePlace ?? row.lastKnownSource,
    nowMs,
  })
}

/** The last ping's time, or null when the shipment has never reported. */
function pingAt(row: ShipmentRow): string | null {
  return row.lastUpdateAt ?? row.lastKnownAt ?? null
}

/** Minutes since the last ping; null when never. */
export function pingAgeMinutes(row: ShipmentRow, nowMs: number): number | null {
  const at = Date.parse(pingAt(row) ?? '')
  return Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 60_000)) : null
}

/** Minutes until the next check call; negative once overdue; null when none is scheduled. */
export function nextCheckMinutes(row: ShipmentRow, nowMs: number): number | null {
  const next = nextCheckCallStateOf(row, nowMs)
  if (next.kind === 'NONE') return null
  return next.kind === 'OVERDUE' ? -next.minutes : next.minutes
}

export function nextCheckText(row: ShipmentRow, nowMs: number): string {
  const next = nextCheckCallStateOf(row, nowMs)
  if (next.kind === 'NONE') return ''
  return next.kind === 'OVERDUE' ? `overdue ${durationText(next.minutes)}` : `in ${durationText(next.minutes)}`
}

export function trackerLabel(row: ShipmentRow, nameOf: (id: string) => string): string {
  if (!row.trackerId) return 'Unassigned'
  return row.trackerName ?? nameOf(row.trackerId)
}

/** Moving first, then Stopped, then No signal; within a motion, the newest ping first. */
function lastLocationSort(row: ShipmentRow, nowMs: number): number {
  const rank = ({ Moving: 1, Stopped: 2, 'No signal': 3 } as Record<string, number>)[motionText(row, nowMs)] ?? 99
  const ts = Date.parse(row.lastUpdateAt ?? row.lastKnownAt ?? '')
  return rank * 1e13 + (1e13 - (Number.isFinite(ts) ? ts : 0))
}

export interface TrackingColumnContext {
  nowMs: number
  nameOf: (id: string) => string
  /** Resolved tracking prefs of a row (customer's choice); the `mode` column prints them. */
  prefsOf?: (row: ShipmentRow) => EffectiveTrackingPrefs
}

export const TRACKING_DEFAULT_COLUMNS = [
  'shipment', 'status', 'customer', 'lane', 'pickup', 'delivery', 'lastLocation', 'ping', 'eta', 'nextCheck', 'pod', 'checkCalls', 'docs', 'carrier', 'tracker',
]

const DOC_STATES = { REVIEW: 'To review', MISSING: 'Missing', OK: 'OK' } as const

const METHOD_SHORT: Record<TrackingMethod, string> = { EMAIL: 'E-mail', SMS: 'SMS', BOTH: 'E-mail + SMS' }

/** The Docs column's state: a carrier upload to review beats missing paperwork beats fine. */
function docStateOf(row: ShipmentRow): keyof typeof DOC_STATES | null {
  if (hasDocsToReview(row)) return 'REVIEW'
  if (row.docsMissing == null) return null
  return row.docsMissing.length > 0 ? 'MISSING' : 'OK'
}

export function docsText(row: ShipmentRow): string {
  if (hasDocsToReview(row)) return `${row.pendingDocReviewCount} to review`
  if (row.docsMissing && row.docsMissing.length > 0) {
    return `Missing: ${row.docsMissing.map((t) => (DOCUMENT_TYPE_LABELS as Record<string, string>)[t] ?? t).join(', ')}`
  }
  return ''
}

/** "Check-in 2 h ago · due in 22 m" / "overdue 35 m"; exceptions appended. */
function checkCallsText(row: ShipmentRow, nowMs: number): string {
  const parts: string[] = []
  if (row.lastCheckCallType) {
    const label = (CHECK_CALL_TYPE_LABELS as Record<string, string>)[row.lastCheckCallType] ?? row.lastCheckCallType
    const ago = relativeTime(row.lastCheckCallAt ?? null, nowMs)
    parts.push(ago ? `${label} ${ago}` : label)
  }
  const next = nextCheckText(row, nowMs)
  if (next) parts.push(next.startsWith('overdue') ? next : `due ${next}`)
  if (hasException(row)) parts.push(`${row.openIncidentCount} exception${row.openIncidentCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function trackingColumns({ nowMs, nameOf, prefsOf }: TrackingColumnContext): DenseColumn<ShipmentRow>[] {
  return [
    { key: 'shipment', header: 'Shipment #', group: 'Shipment', text: (r) => r.number },
    {
      key: 'status',
      header: 'Status',
      group: 'Shipment',
      text: (r) => [boardStatusOf(r), nextEventText(r, nowMs), r.trackingFlaggedAt ? 'Tracking flag' : null].filter(Boolean).join(' · '),
      filter: 'multi',
      optionsOf: (r) => [statusOptionOf(r)],
      fixedOptions: STATUS_KEYS.map((s) => ({ value: s, label: titleCase(s) })),
      sortValue: (r) => STATUS_ORDER[boardStatusOf(r)] ?? 99,
    },
    { key: 'customer', header: 'Customer', group: 'Shipment', text: (r) => r.customerName ?? '', filter: 'multi' },
    {
      key: 'lane',
      header: 'Lane',
      group: 'Shipment',
      text: (r) => `${r.originCity ?? '—'} → ${r.destinationCity ?? '—'}`,
      sortValue: (r) => r.originCity ?? '',
    },
    {
      key: 'pickup',
      header: 'Pickup',
      group: 'Shipment',
      text: (r) => (r.pickupAppt ? formatBoardDateTime(r.pickupAppt) : ''),
      filter: 'date',
      dateOf: (r) => r.pickupAppt ?? null,
    },
    {
      key: 'delivery',
      header: 'Delivery',
      group: 'Shipment',
      text: (r) => (r.deliveryAppt ? formatBoardDateTime(r.deliveryAppt) : ''),
      filter: 'date',
      dateOf: (r) => r.deliveryAppt ?? null,
    },
    {
      key: 'lastLocation',
      header: 'Last location',
      group: 'Tracking',
      text: (r) => [r.lastUpdatePlace ?? r.lastKnownCity ?? '', motionText(r, nowMs)].filter(Boolean).join(' · '),
      sortValue: (r) => lastLocationSort(r, nowMs),
    },
    {
      key: 'ping',
      header: 'Ping age',
      group: 'Tracking',
      text: (r) => relativeTime(pingAt(r), nowMs) ?? '',
      filter: 'number',
      numberOf: (r) => pingAgeMinutes(r, nowMs),
      numberUnit: 'min',
      align: 'right',
    },
    {
      key: 'eta',
      header: 'ETA',
      group: 'Tracking',
      text: (r) => {
        const eta = etaOf(r, nowMs)
        return eta ? `${formatBoardDateTime(eta.at)}${eta.estimated ? ' est.' : ''}${eta.lateMinutes ? ` late ${durationText(eta.lateMinutes)}` : ''}` : ''
      },
      filter: 'date',
      dateOf: (r) => etaOf(r, nowMs)?.at ?? null,
    },
    {
      key: 'nextCheck',
      header: 'Next check',
      group: 'Tracking',
      text: (r) => nextCheckText(r, nowMs),
      filter: 'number',
      numberOf: (r) => nextCheckMinutes(r, nowMs),
      numberUnit: 'min, negative = overdue',
      align: 'right',
    },
    {
      key: 'pod',
      header: 'POD',
      group: 'Tracking',
      text: (r) => {
        const state = podStateOf(r)
        return state === 'NOT_DUE' ? '' : POD_LABELS[state]
      },
      filter: 'multi',
      optionsOf: (r) => {
        const state = podStateOf(r)
        return state === 'NOT_DUE' ? [] : [{ value: state, label: POD_LABELS[state] }]
      },
      fixedOptions: (Object.keys(POD_LABELS) as Array<keyof typeof POD_LABELS>).map((k) => ({ value: k, label: POD_LABELS[k] })),
    },
    {
      key: 'checkCalls',
      header: 'Check calls',
      group: 'Tracking',
      text: (r) => checkCallsText(r, nowMs),
      filter: 'number',
      numberOf: (r) => {
        const next = nextCheckCallStateOf(r, nowMs)
        return next.kind === 'OVERDUE' ? next.minutes : null
      },
      numberUnit: 'min overdue',
      align: 'right',
    },
    {
      key: 'docs',
      header: 'Docs',
      group: 'Tracking',
      text: docsText,
      filter: 'multi',
      optionsOf: (r) => {
        const state = docStateOf(r)
        return state ? [{ value: state, label: DOC_STATES[state] }] : []
      },
      fixedOptions: (Object.keys(DOC_STATES) as Array<keyof typeof DOC_STATES>).map((k) => ({ value: k, label: DOC_STATES[k] })),
    },
    {
      key: 'carrier',
      header: 'Carrier DOT/MC',
      group: 'Carrier',
      text: (r) => (r.carrierName || r.carrierMc || r.carrierDot ? `${r.carrierName ?? '—'} · DOT ${r.carrierDot ?? '—'} · MC ${r.carrierMc ?? '—'}` : ''),
      filter: 'multi',
      optionsOf: (r) => (r.carrierName ? [{ value: r.carrierName, label: r.carrierName }] : []),
    },
    {
      key: 'tracker',
      header: 'Tracker',
      group: 'Tracking',
      text: (r) => trackerLabel(r, nameOf),
      filter: 'multi',
      optionsOf: (r) => [{ value: r.trackerId ?? UNASSIGNED_KEY, label: trackerLabel(r, nameOf) }],
    },
    ...(prefsOf
      ? [{
          key: 'mode',
          header: 'Tracking mode',
          group: 'Tracking',
          text: (r: ShipmentRow) => {
            const p = prefsOf(r)
            if (p.mode === 'MANUAL') return 'Manual'
            return `${p.mode === 'AGENT' ? 'Agent' : 'Not set'}${p.method ? ` · ${METHOD_SHORT[p.method]}` : ''}`
          },
        } satisfies DenseColumn<ShipmentRow>]
      : []),
  ]
}

export const TRACKING_ACTIONS_COLUMN: DenseColumn<ShipmentRow> = {
  key: 'actions',
  header: '',
  text: () => '',
  fixed: true,
  filter: false,
  sortable: false,
  width: 40,
}

export interface TrackingGrouper {
  label: string
  describe: (row: ShipmentRow, nameOf: (id: string) => string) => { key: string; label: string }
  /** The group that sorts before the alphabetical rest. */
  firstKey?: string
}

/** What the Group by control offers. `assignee` is the default. */
export const TRACKING_GROUPERS: Record<string, TrackingGrouper> = {
  assignee: {
    label: 'Assignee',
    describe: (r, nameOf) => ({ key: r.trackerId ?? UNASSIGNED_KEY, label: trackerLabel(r, nameOf) }),
    firstKey: UNASSIGNED_KEY,
  },
  status: {
    label: 'Status',
    describe: (r) => {
      const { value, label } = statusOptionOf(r)
      return { key: value, label }
    },
  },
  customer: {
    label: 'Customer',
    describe: (r) => ({ key: r.customerName ?? '', label: r.customerName ?? 'No customer' }),
  },
  carrier: {
    label: 'Carrier',
    describe: (r) => ({ key: r.carrierName ?? '', label: r.carrierName ?? 'No carrier' }),
  },
  pod: {
    label: 'POD',
    describe: (r) => {
      const state = podStateOf(r)
      return { key: state, label: state === 'NOT_DUE' ? 'Not due' : POD_LABELS[state] }
    },
  },
}
