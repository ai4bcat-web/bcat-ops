/**
 * The steps a shipment goes through, from Created to Paid, with where it is now, what the next
 * step is, and for every finished step the carrier it concerns and who did it.
 *
 * Pure: a shipment bundle plus its audit rows in, a list out. The lifecycle position comes from
 * `stageOfBundle` (so this can never disagree with the stage chip); the carrier facts come from the
 * active LoadCarrier row; "who" comes from the audit entry the Lambda wrote for the step, falling
 * back to what the row itself records. Relative imports only.
 */
import { CARRIER_ASSIGNMENT_STATUSES, driverInfoGaps, rungOf } from './carrierAssignment'
import { assetModeOf, assetStepRows, isAssetShipment, type AssetContext } from './assetSteps'
import { catalogStep, resolveSteps, type ProgressStepsConfig, type StepKey, type StepVariant } from './progressSteps'
import { resolveActor, type StaffLike } from './auditActors'
import { STAGE_LADDER, stageOfBundle, type LadderStage } from './shipmentStage'
import type { LoadCarrierRecord, ShipmentBundle } from '../types/tms'

export type { StepKey } from './progressSteps'

export type StepState = 'done' | 'next' | 'todo'

export interface ShipmentStep {
  key: StepKey
  label: string
  state: StepState
  /** The carrier (or own-fleet driver) a carrier-level step concerns. */
  carrier: string | null
  /** Who did it: a person's name, an agent's name or the signer; null when nobody is recorded. */
  by: string | null
  at: string | null
  /** The next step in a few words, for a chip ("Cover it"). */
  short: string
  /** For the next step: what to do, in the imperative ("Cover it: choose the carrier or book Ivan Cartage"). */
  action: string | null
  /** Why the next step cannot be done yet, when it cannot. */
  waiting: string | null
}

const SHORT: Record<StepKey, string> = {
  created: 'Create it', covered: 'Cover it', setup: 'Carrier setup', rateConSent: 'Send rate con', rateConSigned: 'Rate con signature',
  driverInfo: 'Enter driver info', dispatched: 'Dispatch', delivered: 'Deliver and get the POD', loadReview: 'Send to Load Review', billed: 'Invoice', paid: 'Collect payment',
  assetAssigned: 'Assign driver', assetStarted: 'Dispatch', assetLocated: 'Truck location', assetArrivedPickup: 'Arrive at pickup', assetLeftPickup: 'Leave pickup', assetArrivedDelivery: 'Arrive at delivery',
}

export interface AuditStepRow {
  entityType: string
  entityId: string
  action: string
  user: string
  createdAt: string
  changes?: unknown
}

const COVER_ACTIONS = ['COVER_CARRIER', 'BOOK_CARRIER', 'ADD_CARRIER', 'ASSIGN_ASSET']

const idx = (stage: LadderStage): number => STAGE_LADDER.indexOf(stage)

/** The newest audit row for one of these actions, on any of these entity ids. */
function auditFor(rows: readonly AuditStepRow[], actions: readonly string[], entityIds: readonly string[]): AuditStepRow | null {
  let best: AuditStepRow | null = null
  for (const r of rows) {
    if (!actions.includes(r.action)) continue
    if (entityIds.length > 0 && !entityIds.includes(r.entityId)) continue
    if (!best || r.createdAt > best.createdAt) best = r
  }
  return best
}

function carrierNameOf(lc: LoadCarrierRecord | null): string | null {
  if (!lc) return null
  if (lc.kind === 'OWN_ASSET') return lc.driverName ? `Ivan Cartage · ${lc.driverName}` : 'Ivan Cartage (own fleet)'
  return lc.carrierName || null
}

interface Who { by: string | null; at: string | null }

/** Build the step list. `staff` resolves login e-mails to names. */
/** What an ASSETS load reads beyond the bundle: the driver's type and the check calls that say who tapped what. Both optional. */
export interface AssetStepExtras {
  driverType?: AssetContext['driverType']
  checkCalls?: AssetContext['checkCalls']
  /** `TmsSettings.progressSteps`: which steps, in what order and under what names, per revenue division. Absent = the built-in defaults. */
  config?: ProgressStepsConfig | null
}

export function buildShipmentSteps(
  bundle: ShipmentBundle | null,
  audits: readonly AuditStepRow[],
  staff: readonly StaffLike[],
  extras: AssetStepExtras = {},
): ShipmentStep[] {
  if (!bundle) return []
  const stage = stageOfBundle(bundle)
  if (stage.terminal) return []
  const pos = stage.step

  const live = bundle.loadCarriers
    .filter((lc) => lc.status === 'ACTIVE')
    .sort((a, b) => ((a.sequence ?? 0) - (b.sequence ?? 0)) || (a.id < b.id ? -1 : 1))
  const lc = live[0] ?? null
  const own = lc?.kind === 'OWN_ASSET'
  const carrier = carrierNameOf(lc)
  const lcIds = live.map((c) => c.id)
  const who = (row: AuditStepRow | null, fallbackUser?: string | null, fallbackAt?: string | null): Who => {
    const user = row?.user ?? fallbackUser ?? null
    return {
      by: user ? resolveActor(user, staff, row?.action).name : null,
      at: row?.createdAt ?? fallbackAt ?? null,
    }
  }

  const rung = rungOf(lc?.assignmentStatus ?? null)
  const setupDone = !!lc && rung >= CARRIER_ASSIGNMENT_STATUSES.indexOf('ASSIGNED_SETUP_COMPLETE')
  const rateSent = !!lc && (rung >= CARRIER_ASSIGNMENT_STATUSES.indexOf('RATE_CON_SENT') || !!lc.rateConSentAt)
  const rateSigned = !!lc && (rung >= CARRIER_ASSIGNMENT_STATUSES.indexOf('RATE_CON_SIGNED') || !!lc.rateConSignedAt)
  const infoIn = !!lc && driverInfoGaps(lc).length === 0
  const created = who(auditFor(audits, ['CREATE_SHIPMENT', 'DUPLICATE_SHIPMENT'], [bundle.shipment.id]), bundle.shipment.createdBy, bundle.shipment.createdAt)
  const covered = who(auditFor(audits, COVER_ACTIONS, lcIds), lc?.createdBy, lc?.bookedAt ?? lc?.createdAt)
  const sent = who(auditFor(audits, ['SEND_RATE_CON'], lcIds), null, lc?.rateConSentAt)
  const signedAudit = auditFor(audits, ['MARK_RATE_CON_SIGNED'], lcIds)
  const signed = who(signedAudit, null, lc?.rateConSignedAt)
  const info = who(auditFor(audits, ['ENTER_DRIVER_INFO'], lcIds), null, null)
  const dispatchedWho = who(auditFor(audits, ['DISPATCH_LOAD'], lcIds), null, lc?.dispatchedAt)
  const delivered = who(auditFor(audits, ['SET_LOAD_STATUS'], bundle.loads.map((l) => l.id)), null, bundle.shipment.deliveredAt)
  const review = who(auditFor(audits, ['PUSH_TO_LOAD_REVIEW'], [bundle.shipment.id]), null, bundle.shipment.loadReviewPushedAt)

  const generic: Array<Omit<ShipmentStep, 'state' | 'action' | 'waiting' | 'short'> & { done: boolean; action: string; waiting?: string | null; skip?: boolean }> = [
    { key: 'created', label: 'Created', done: true, carrier: null, by: created.by, at: created.at, action: 'Create the shipment' },
    {
      key: 'covered', label: own ? 'Covered by our own fleet' : 'Covered', done: !!lc, carrier, by: lc ? covered.by : null, at: lc ? covered.at : null,
      action: 'Cover it: choose the carrier, or book Ivan Cartage and pick the driver',
    },
    {
      key: 'setup', label: 'Carrier set up', done: setupDone, carrier, by: setupDone ? 'MyCarrierPackets' : null,
      at: lc?.assignmentTimes && typeof lc.assignmentTimes === 'string' ? safeTime(lc.assignmentTimes, 'ASSIGNED_SETUP_COMPLETE') : null,
      action: 'Wait for the carrier to finish setup in MyCarrierPackets',
      waiting: 'The carrier has not finished setup in MyCarrierPackets yet', skip: own || !lc,
    },
    {
      key: 'rateConSent', label: 'Rate confirmation sent', done: rateSent, carrier, by: rateSent ? sent.by : null, at: rateSent ? sent.at : null,
      action: `Send the rate confirmation${carrier ? ` to ${carrier}` : ''}`,
      waiting: setupDone || !lc || own ? null : 'The carrier has to be set up first', skip: own,
    },
    {
      key: 'rateConSigned', label: 'Rate confirmation signed', done: rateSigned, carrier,
      by: rateSigned ? (lc?.rateConSignerName || signed.by) : null, at: rateSigned ? signed.at : null,
      action: 'Wait for the carrier to sign the rate confirmation, or mark it signed', waiting: 'The carrier has not signed yet', skip: own,
    },
    {
      key: 'driverInfo', label: 'Driver and truck info in', done: infoIn, carrier, by: infoIn ? (info.by ?? (own ? covered.by : null)) : null, at: infoIn ? info.at : null,
      action: `Enter the driver name, phone, truck and trailer${carrier ? ` for ${carrier}` : ''}`,
    },
    {
      key: 'dispatched', label: 'Dispatched', done: !!lc?.dispatchedAt || pos >= idx('IN_TRANSIT'), carrier,
      by: lc?.dispatchedAt || pos >= idx('IN_TRANSIT') ? dispatchedWho.by : null, at: dispatchedWho.at,
      action: 'Dispatch the load', waiting: infoIn ? null : 'Driver and truck info has to be in first',
    },
    { key: 'delivered', label: 'Delivered', done: pos >= idx('DELIVERED'), carrier, by: delivered.by, at: delivered.at, action: 'Track the load to delivery and collect the POD' },
    { key: 'loadReview', label: 'Sent to Load Review', done: pos >= idx('LOAD_REVIEW'), carrier: null, by: review.by, at: review.at, action: 'Review the paperwork and send the load to billing' },
    { key: 'billed', label: 'Billed', done: pos >= idx('BILLED'), carrier: null, by: null, at: null, action: 'Invoice the customer' },
    { key: 'paid', label: 'Paid', done: pos >= idx('PAID'), carrier: null, by: null, at: null, action: 'Collect payment' },
  ]


  const afterDelivered = pos >= idx('DELIVERED')
  // A delivered shipment did every step before delivery, whether or not anybody recorded it.
  const BEFORE_DELIVERY = new Set(['covered', 'setup', 'rateConSent', 'rateConSigned', 'driverInfo', 'dispatched'])
  type Raw = Omit<ShipmentStep, 'state' | 'action' | 'waiting' | 'short'> & { done: boolean; action: string; waiting?: string | null; skip?: boolean; short?: string }
  const rows = new Map<string, Raw>()
  for (const r of generic) rows.set(r.key, afterDelivered && BEFORE_DELIVERY.has(r.key) && !r.done ? { ...r, done: true } : r)
  const asset = isAssetShipment(bundle)
  const variant: StepVariant = asset ? (assetModeOf(extras.driverType, bundle) === 'MOTIVE' ? 'OWNER_OPERATOR' : 'LOCAL_DRIVER') : 'CARRIER'
  if (asset) {
    for (const r of assetStepRows({ bundle, lc, driverType: extras.driverType, checkCalls: extras.checkCalls ?? [], delivered: afterDelivered })) rows.set(r.key, { ...r, key: r.key as StepKey })
  }
  // The steps Settings chose for this revenue division (else the defaults), in that order, under the names it gave them. A label left equal to the
  // catalog name is not a rename, so the dynamic wording ("Covered by our own fleet") stays.
  const raw: Raw[] = []
  for (const setting of resolveSteps(extras.config, bundle.shipment.revDivision, variant)) {
    const row = rows.get(setting.key)
    if (!setting.enabled || !row) continue
    const renamed = setting.label.trim() !== '' && setting.label !== catalogStep(setting.key)?.label
    raw.push(renamed ? { ...row, label: setting.label } : row)
  }

  let nextAssigned = false
  const steps: ShipmentStep[] = []
  for (const r of raw) {
    if (r.skip) continue
    const state: StepState = r.done ? 'done' : !nextAssigned ? 'next' : 'todo'
    if (state === 'next') nextAssigned = true
    steps.push({
      key: r.key, label: r.label, state, carrier: r.carrier, by: r.by, at: r.at, short: r.short ?? SHORT[r.key],
      action: state === 'next' ? r.action : null, waiting: state === 'next' ? (r.waiting ?? null) : null,
    })
  }
  return steps
}

function safeTime(raw: string, key: string): string | null {
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  } catch { return null }
}

/** The one thing to do next, or null when every step is done (or the shipment is voided / canceled). */
export function nextStepOf(steps: readonly ShipmentStep[]): ShipmentStep | null {
  return steps.find((s) => s.state === 'next') ?? null
}
