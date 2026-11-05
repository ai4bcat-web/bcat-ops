/**
 * Step AR summary-rail model: pure functions the rail renders. The required checklist is derived
 * from `validateForm`'s blocking issues (the SAME call that gates Create), so the checklist and the
 * Create button can never disagree: all rows done ⇔ no blocking issue.
 */
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import { TRUCKLOAD_MODES } from '../orderDraft'
import { LABEL } from './labels'
import { firstPickupIndex, lastDeliveryIndex } from './mapping'
import type { ShipmentFormValues } from './model'
import type { CardKey } from './cards/cardRegistry'
import { ratesSummary, type RatesSummary } from './cards/ratesSummary'
import { blockingIssues, validateForm, type ValidationLevel } from './validation'

export interface RailRow {
  /** Stable: a fixed row key (`customer`, `weight`…) or the extra issue's id. */
  key: string
  label: string
  done: boolean
  /** `data-testid` of the control to focus. */
  fieldKey: string
  card: CardKey | 'more' | 'rail'
  /** The validation message when not done. */
  message: string
}

export interface RequiredOpts {
  customer?: CustomerRecord | null
  settings?: TmsSettings | null
  level?: ValidationLevel
}

interface FixedRow {
  key: string
  label: string
  /** validateForm issue ids this row owns. */
  ids: string[]
  fieldKey: string
  card: RailRow['card']
  truckloadOnly?: boolean
}

const FIXED: FixedRow[] = [
  { key: 'customer', label: 'Customer', ids: ['customer:name'], fieldKey: LABEL.customer.name.testId, card: 'customer' },
  { key: 'pickup', label: 'Pickup', ids: ['picks:pickup', 'pickup:name'], fieldKey: LABEL.pickup.name.testId, card: 'route' },
  { key: 'ready', label: 'Ready', ids: ['pickup:ready'], fieldKey: LABEL.pickup.ready.testId, card: 'route' },
  { key: 'equipment', label: 'Equipment', ids: ['shipping:equipmentType'], fieldKey: LABEL.shipping.equipmentType.testId, card: 'freight', truckloadOnly: true },
  { key: 'weight', label: 'Weight', ids: ['shipping:weightLbs'], fieldKey: LABEL.shipping.weightLbs.testId, card: 'freight' },
  { key: 'description', label: 'Description', ids: ['shipping:description'], fieldKey: LABEL.shipping.description.testId, card: 'freight' },
  { key: 'revenue', label: 'Revenue type', ids: ['shipping:revDivision'], fieldKey: LABEL.shipping.revDivision.testId, card: 'freight' },
]

const CARD_OF_SECTION: Record<string, RailRow['card']> = {
  customer: 'customer', pickup: 'route', consignee: 'route', picks: 'route', shipping: 'freight',
  rates: 'rates', carrier: 'carrier', more: 'more', roles: 'rail', history: 'rateHistory', documents: 'documents', checkCalls: 'tracking',
}

export function cardOfSection(section: string): RailRow['card'] {
  return CARD_OF_SECTION[section] ?? 'rail'
}

/**
 * The required checklist. `mode` only picks the default level (Create and Save both validate at
 * `create`). Any other blocking issue (a customer's required reference, a carrier origin…) joins
 * as its own undone row, so N / M reaches M / M exactly when nothing blocks.
 */
export function requiredRows(values: ShipmentFormValues, mode: 'create' | 'edit', opts: RequiredOpts = {}): RailRow[] {
  const level: ValidationLevel = opts.level ?? 'create'
  const blocking = blockingIssues(validateForm(values, {
    level, mode, customer: opts.customer ?? null, settings: opts.settings ?? null,
  }))
  const byId = new Map(blocking.map((i) => [i.id, i]))
  const truckload = (TRUCKLOAD_MODES as string[]).includes(values.mode)
  const covered = new Set<string>()
  const rows: RailRow[] = []
  for (const f of FIXED) {
    if (f.truckloadOnly && !truckload) continue
    f.ids.forEach((id) => covered.add(id))
    const hit = f.ids.map((id) => byId.get(id)).find(Boolean)
    rows.push({ key: f.key, label: f.label, done: !hit, fieldKey: hit?.fieldKey ?? f.fieldKey, card: f.card, message: hit?.message ?? '' })
  }
  for (const i of blocking) {
    if (covered.has(i.id)) continue
    rows.push({ key: i.id, label: i.label, done: false, fieldKey: i.fieldKey, card: cardOfSection(i.section), message: i.message })
  }
  return rows
}

export function requiredProgress(rows: readonly RailRow[]): { done: number; total: number; ready: boolean } {
  const done = rows.filter((r) => r.done).length
  return { done, total: rows.length, ready: done === rows.length }
}

export interface RailSummary {
  customerLine: string
  laneLine: string
  freightLine: string
  money: RatesSummary
}

const place = (s: { city: string; state: string } | undefined): string => {
  if (!s) return ''
  return [s.city.trim(), s.state.trim().toUpperCase()].filter(Boolean).join(', ')
}

export function railSummary(values: ShipmentFormValues, customer: CustomerRecord | null, settings: TmsSettings | null): RailSummary {
  const name = customer?.name ?? values.customer.typedName.trim()
  const days = values.customer.billToId
    ? (customer?.billToParties?.find((b) => b.id === values.customer.billToId)?.paymentTermsDays ?? customer?.paymentTermsDays)
    : customer?.paymentTermsDays
  const customerLine = [
    name,
    days == null ? '' : days === 0 ? 'Due on receipt' : `Net ${days}`,
    customer?.factored === true ? 'Factored' : '',
  ].filter(Boolean).join(' · ')

  const from = place(values.stops[firstPickupIndex(values.stops)])
  const to = place(values.stops[lastDeliveryIndex(values.stops)])
  const miles = Number(values.ship.customerMiles) > 0 ? `${Number(values.ship.customerMiles).toLocaleString('en-US')} mi` : ''
  const lane = from || to ? `${from || '—'} → ${to || '—'}` : ''
  const laneLine = [lane, miles].filter(Boolean).join(' · ')

  const weight = Number(values.ship.weightLbs) > 0 ? `${Number(values.ship.weightLbs).toLocaleString('en-US')} lb` : ''
  const freightLine = [values.ship.equipmentType.trim(), weight, values.ship.description.trim()].filter(Boolean).join(' · ')

  return { customerLine, laneLine, freightLine, money: ratesSummary(values, customer, settings) }
}

/** The PRO the next create would mint (prefix + counter, padded to six); '' until settings arrive. The number is minted on Create. */
export function proPreview(settings: TmsSettings | null): string {
  if (settings?.nextShipmentNumber == null) return ''
  return `${(settings.shipmentPrefix ?? '').trim() || 'S'}${String(settings.nextShipmentNumber || 1).padStart(6, '0')}`
}
