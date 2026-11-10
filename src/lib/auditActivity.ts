/**
 * Pure formatting behind the summary rail's Activity block: relative time, plain-language action
 * sentences, the one-line detail of an audit row's `changes` (field name + new value, hover shows
 * the old value) and the newest-first limited list. No clock, no network: callers pass `nowMs`.
 *
 * The action strings are the real ones the Lambdas write (`writeAudit('SHIPMENT' | 'LOAD' |
 * 'LOAD_CARRIER' | 'ORDER' | 'INTAKE_LOAD' | 'SHIPMENT_DOCUMENT' | 'SHIPMENT_POSTING' |
 * 'TRACKING_LINK', id, ACTION, …)`) plus the browser writers' `create | update | delete`.
 */
import { resolveActor, type ResolvedActor, type StaffLike } from './auditActors'

export const ACTIVITY_LIMIT = 8

/** AuditLog.action -> a verb phrase that follows the actor ("Dee <covered the load>"). */
export const ACTION_SENTENCE: Record<string, string> = {
  CREATE_SHIPMENT: 'created the shipment',
  DUPLICATE_SHIPMENT: 'duplicated the shipment',
  SAVE_ORDER_FORM: 'saved the shipment form',
  UPDATE_ORDER_DETAILS: 'updated the order details',
  SUBMIT_ORDER: 'submitted the order',
  VOID_SHIPMENT: 'voided the shipment',
  UNVOID_SHIPMENT: 'restored the voided shipment',
  CONVERT_QUOTE: 'converted the quote to this shipment',
  REVERT_TO_QUOTE: 'reverted this shipment to a quote',
  SET_SHIPMENT_CUSTOMER: 'set the customer',
  REPOINT_SHIPMENT_CUSTOMER: 'moved the shipment to another customer',
  SET_SALES_REP: 'set the sales rep',
  ASSIGN_CARRIER_REP: 'assigned the carrier rep',
  ASSIGN_TRACKER: 'assigned the tracker',
  SET_REV_TAG: 'set the revenue tag',
  RESOLVE_REV_TAG: 'resolved the revenue tag',
  CLEAR_REV_TAG: 'cleared the revenue tag',
  SET_TRACKING_PREFS: 'changed the tracking preferences',
  RECALC_CHARGES: 'recalculated the charges',
  PUSH_TO_LOAD_REVIEW: 'pushed the shipment to Load Review',
  LOAD_REVIEW_RELEASED: 'released the shipment from Load Review',
  READY_TO_INVOICE: 'released the order to billing',
  SET_AR_STATUS: 'changed the billing status',
  SEND_MILESTONE_NOTICE: 'sent a milestone notice',
  EMAIL_DOCUMENTS: 'e-mailed documents',
  ASSIGN_INBOUND_OFFER: 'assigned a carrier offer to the load',
  FILE_INBOUND_OFFER: 'filed a carrier offer',
  DISMISS_INBOUND_OFFER: 'dismissed a carrier offer',
  TRACKING_AUTOMATION_ERROR: 'hit a tracking error',
  RUN_TRACKING_AUTOMATION: 'ran tracking automation',
  // Load
  SET_LOAD_STATUS: 'changed the load status',
  SET_LOAD_PRO: 'set the load PRO',
  SET_LOAD_REFS: 'changed the TMS # / PU #',
  SET_STOP_DRIVERS: 'changed the driver on a stop',
  SET_NEXT_CHECK_CALL: 'scheduled the next check call',
  REQUEST_OFFERS: 'requested carrier offers',
  RESOLVE_INCIDENT: 'resolved an incident',
  CHANGE_ASSET_DRIVER: 'changed the driver',
  // Carrier assignment
  ASSIGN_CARRIER: 'covered the load with a carrier',
  ASSIGN_ASSET: 'assigned an own-fleet asset',
  RATE_CARRIER: 'set the carrier rate',
  UPDATE_CARRIER_CHARGES: 'updated the carrier charges',
  UPDATE_LOAD_CARRIER_DETAILS: 'updated the carrier details',
  ENTER_DRIVER_INFO: 'entered driver info',
  SEND_RATE_CON: 'sent the rate confirmation',
  VOID_RATE_CON: 'voided the rate confirmation',
  MARK_RATE_CON_SIGNED: 'marked the rate confirmation signed',
  rate_con_opened: 'opened the rate confirmation link',
  rate_con_signed: 'signed the rate confirmation',
  rate_con_declined: 'declined the rate confirmation',
  rate_con_link_superseded: 'replaced the previous rate confirmation link with a new version',
  rate_con_document_superseded: 'replaced the previous signed rate confirmation in Documents',
  rate_con_link_rejected: 'was refused on a rate confirmation link',
  rate_con_sign_rejected: 'failed a rate confirmation signing attempt',
  SET_ETA: 'set the ETA',
  SET_QUICK_PAY: 'changed quick pay',
  TEXT_DRIVER: 'texted the driver',
  // Documents
  COMMIT_DOCUMENT: 'uploaded a document',
  INGEST_ATTACHMENT: 'filed an e-mail attachment',
  ATTACH_DRIVER_DOC: 'attached a driver document',
  SAVE_GENERATED_DOCUMENT: 'generated a document',
  EMAIL_BOL: 'e-mailed the bill of lading',
  REVIEW_DOCUMENT: 'reviewed a document',
  UPDATE_DOCUMENT: 'updated a document',
  VOID_DOCUMENT: 'voided a document',
  // Tracking links and postings
  SEND_TRACKING_LINK: 'sent a tracking link',
  SEND_CUSTOMER_LINK: 'sent the customer a tracking link',
  SEND_UPLOAD_LINK: 'sent a document upload link',
  REVOKE_TRACKING_LINK: 'revoked a tracking link',
  REVOKE_CUSTOMER_LINK: 'revoked the customer tracking link',
  REVOKE_UPLOAD_LINK: 'revoked an upload link',
  START_PROVIDER_TRACKING: 'started provider tracking',
  STOP_PROVIDER_TRACKING: 'stopped provider tracking',
  EXTEND_CUSTOMER_LINK: 'extended the customer tracking link',
  POST_LOAD: 'posted the load to a board',
  UNPOST_LOAD: 'took the load off a board',
  // Intake
  INTAKE_EXTRACTED: 'extracted the fields from the e-mail',
  INTAKE_SAVE_DRAFT: 'saved the intake draft',
  INTAKE_MARK_REVIEWED: 'marked the intake reviewed',
  INTAKE_MOVE_TO_ACTIVE: 'moved the intake load to Active',
  INTAKE_LINK_SHIPMENT: 'linked the intake load to the shipment',
  INTAKE_DISMISS: 'dismissed the intake load',
  // Browser writers
  create: 'created',
  update: 'updated',
  delete: 'deleted',
}

const ENTITY_NOUN: Record<string, string> = {
  shipment: 'the shipment', load: 'the load', order: 'the order', loadcarrier: 'the carrier assignment', intake_load: 'the intake load',
}

const humanise = (s: string): string =>
  s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()

/** The sentence for an action; unknown actions fall back to the action name in plain words. */
export function actionSentence(action: string, entityType = ''): string {
  const known = Object.hasOwn(ACTION_SENTENCE, action) ? ACTION_SENTENCE[action] : undefined
  if (known) {
    if (action === 'create' || action === 'update' || action === 'delete') {
      const noun = Object.hasOwn(ENTITY_NOUN, entityType.toLowerCase()) ? ENTITY_NOUN[entityType.toLowerCase()] : undefined
      return noun ? `${known} ${noun}` : known
    }
    return known
  }
  return humanise(action) || 'made a change'
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. Pure: differences of instants only. */
export function relativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const sec = Math.max(0, Math.round((nowMs - at) / 1000))
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(sec / 3600)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(sec / 86_400)
  if (day < 30) return `${day}d ago`
  return iso.slice(0, 10)
}

/** Never printed, even as the first field: bodies, secrets, links that carry a token. */
const HIDDEN_KEY = /(body|message|html|text|token|secret|password|passcode|authorization|signature|apikey|api_key|credential|link|url|note|reason)/i
/** Printed by name but the value is masked. */
const PII_KEY = /(phone|mobile|email|ssn|taxid|tax_id|ein|dob|birth|license|licence|account|routing|card|address|street|contact|driver)/i

const MASK = '••••'

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'blank'
  if (PII_KEY.test(key)) return MASK
  if (typeof value === 'number' && /cents$/i.test(key)) return `$${(value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}` : 'updated'
  const s = String(value)
  return s.length > 60 ? `${s.slice(0, 57)}…` : s
}

const isFromTo = (v: unknown): v is { from?: unknown; to?: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && ('to' in v || 'from' in v)

export interface DetailText { text: string; title: string }

/**
 * The first changed field as `field: new value`; `title` carries the old value for the hover.
 * `changes` is either `{field: {from, to}}` or a flat `{field: value}` (the routers pass both).
 */
export function auditDetail(input: unknown): DetailText | null {
  // AppSync hands AWSJSON back as a string, sometimes encoded twice: unwrap one more level.
  let changes = input
  if (typeof changes === 'string') { try { changes = JSON.parse(changes) } catch { return null } }
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return null
  for (const [key, raw] of Object.entries(changes as Record<string, unknown>)) {
    if (HIDDEN_KEY.test(key)) continue
    const next = isFromTo(raw) ? raw.to : raw
    // A nested object that is not a from/to pair has no one value worth printing.
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) continue
    const field = humanise(key.replace(/Cents$/, ''))
    const text = `${field}: ${formatValue(key, next)}`
    const title = isFromTo(raw) && 'from' in raw ? `was ${formatValue(key, raw.from)}` : ''
    return { text, title }
  }
  return null
}

/** The slice of an AuditLog row the block needs (the apiClient row, `changes` parsed). */
export interface AuditRowLike {
  id: string
  entityType: string
  action: string
  user: string
  changes: unknown
  createdAt: string
}

export interface ActivityRow {
  id: string
  time: string
  timeTitle: string
  actor: ResolvedActor
  action: string
  detail: string
  detailTitle: string
}

/** Newest first, same action by the same actor in the same instant written to two entities shown once, limited. */
export function buildActivityRows(
  entries: readonly AuditRowLike[],
  staff: readonly StaffLike[],
  nowMs: number,
  limit = ACTIVITY_LIMIT,
): ActivityRow[] {
  const sorted = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  const seen = new Set<string>()
  const rows: ActivityRow[] = []
  for (const e of sorted) {
    const dupe = `${e.createdAt}|${e.action}|${e.user}`
    if (seen.has(dupe)) continue
    seen.add(dupe)
    const detail = auditDetail(e.changes)
    rows.push({
      id: e.id,
      time: relativeTime(e.createdAt, nowMs),
      timeTitle: e.createdAt,
      actor: resolveActor(e.user, staff, e.action),
      action: actionSentence(e.action, e.entityType),
      detail: detail?.text ?? '',
      detailTitle: detail?.title ?? '',
    })
    if (rows.length === limit) break
  }
  return rows
}
