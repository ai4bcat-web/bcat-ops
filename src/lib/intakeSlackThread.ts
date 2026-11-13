/**
 * Process updates in the intake Slack threads (Ryne 2026-11-12). A tender e-mail to ivanloads@ / bcatloads@ reaches us twice: the
 * Apps Script mail bridge stages it as an IntakeLoad, and Slack's e-mail integration posts the same message into #intake-ivan /
 * #intake-bcat. We do not own that Slack post, so the thread is found by matching the e-mail itself: Slack's e-mail file carries the
 * message's own Date header as `timestamp` (to the second, the same instant the bridge stores as `receivedAt`) and its subject.
 *
 * What gets posted is decided here from DynamoDB stream images (IntakeLoad, Shipment, ShipmentDocument, Invoice), so the Lambda only
 * does I/O for records that produce an event. Money never goes into a thread: no rates, carrier pay, amounts or margins — names,
 * numbers and milestones only. Relative imports only (Lambda-bundled).
 */
import { INTAKE_DELETED_REASON, dupSubjectKey } from './intakeDup'

export type IntakeThreadEventKind =
  | 'duplicate'
  | 'created'
  | 'dismissed'
  | 'carrierBooked'
  | 'pickedUp'
  | 'delivered'
  | 'podReceived'
  | 'releasedToBilling'
  | 'invoiceSent'

/** Every event the threads can carry. Set one to false to stop posting it; nothing else changes. */
export const INTAKE_THREAD_EVENTS: Record<IntakeThreadEventKind, boolean> = {
  duplicate: true,
  created: true,
  dismissed: true,
  carrierBooked: true,
  pickedUp: true,
  delivered: true,
  podReceived: true,
  releasedToBilling: true,
  invoiceSent: true,
}

export interface IntakeThreadEvent {
  kind: IntakeThreadEventKind
  /** Idempotency key, unique per intake row: the same key is never posted twice. */
  key: string
  /** The IntakeLoad id when the record names it; null when it must be read off the shipment. */
  intakeId: string | null
  shipmentId: string | null
  /** Facts the message needs; never money. */
  data: Record<string, string | null>
}

type Img = Record<string, unknown> | null | undefined

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function jsonish<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw as T | null | undefined) ?? fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

const enabled = (events: IntakeThreadEvent[]): IntakeThreadEvent[] => events.filter((e) => INTAKE_THREAD_EVENTS[e.kind])

// ── IntakeLoad ──────────────────────────────────────────────────────────────

interface BuiltRef { shipmentId?: string; number?: string | null; customerName?: string | null; value?: string | null }

export function intakeLoadEvents(oldImg: Img, newImg: Img): IntakeThreadEvent[] {
  if (!newImg) return []
  const id = str(newImg.id)
  if (!id) return []
  const out: IntakeThreadEvent[] = []
  if (!oldImg) {
    const built = jsonish<BuiltRef[]>(newImg.alreadyBuilt, [])
    const pros = built.map((b) => str(b.number)).filter((n): n is string => !!n)
    if (pros.length) {
      const first = built.find((b) => str(b.number))!
      out.push({
        kind: 'duplicate',
        key: 'duplicate',
        intakeId: id,
        shipmentId: null,
        data: { pros: [...new Set(pros)].slice(0, 3).join(', '), ref: str(first.value), customer: str(first.customerName) },
      })
    }
  }
  const was = str(oldImg?.status)
  const now = str(newImg.status)
  const shipmentId = str(newImg.shipmentId)
  const number = str(newImg.shipmentNumber)
  if (now === 'MOVED' && was !== 'MOVED' && shipmentId) {
    out.push({
      kind: 'created',
      key: 'created',
      intakeId: id,
      shipmentId,
      data: { pro: number, by: str(newImg.updatedBy) },
    })
  }
  // A person's dismissal only: a bulk sweep script (dismissedBy is not an e-mail) must not post into every thread it touches.
  if (now === 'DISMISSED' && was !== 'DISMISSED' && oldImg && (str(newImg.dismissedBy) ?? '').includes('@')) {
    const reason = str(newImg.dismissReason) ?? ''
    const deleted = reason.startsWith(INTAKE_DELETED_REASON)
    const note = deleted ? reason.slice(INTAKE_DELETED_REASON.length).replace(/^\s*:\s*/, '') : reason
    out.push({
      kind: 'dismissed',
      key: `dismissed:${str(newImg.dismissedAt) ?? ''}`,
      intakeId: id,
      shipmentId: null,
      data: { by: str(newImg.dismissedBy), note: note || null, deleted: deleted ? 'yes' : null },
    })
  }
  return enabled(out)
}

// ── Shipment ────────────────────────────────────────────────────────────────

const BOOKED = new Set(['BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING'])
const MOVING = new Set(['PICKED_UP', 'IN_TRANSIT', 'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING'])

/** 0 not covered, 1 booked, 2 picked up / moving, 3 delivered; -1 canceled. */
export function shipmentStage(status: unknown): number {
  const s = str(status)
  if (!s) return 0
  if (s === 'CANCELED') return -1
  if (s === 'DELIVERED') return 3
  if (MOVING.has(s)) return 2
  if (BOOKED.has(s)) return 1
  return 0
}

export function shipmentEvents(oldImg: Img, newImg: Img): IntakeThreadEvent[] {
  if (!newImg) return []
  const intakeId = str(newImg.intakeLoadId)
  const shipmentId = str(newImg.id)
  if (!intakeId || !shipmentId || str(newImg.deletedAt) || str(newImg.voidedAt)) return []
  const before = shipmentStage(oldImg?.status)
  const after = shipmentStage(newImg.status)
  const pro = str(newImg.number)
  const base = { intakeId, shipmentId }
  const out: IntakeThreadEvent[] = []
  // Covered: the status reached booked or later, or the carrier ladder started, for the first time.
  const assignedNow = !!str(newImg.carrierAssignmentStatus) && !str(oldImg?.carrierAssignmentStatus)
  if (after === 2 && before < 2) out.push({ ...base, kind: 'pickedUp', key: 'pickedUp', data: { pro } })
  if (after === 3 && before < 3) out.push({ ...base, kind: 'delivered', key: 'delivered', data: { pro } })
  // Offered again with every later milestone: a carrier name that was not on the load yet when it was booked still gets its line
  // (once — the key is claimed only when the line is posted).
  if (after >= 0 && ((after >= 1 && before < 1) || assignedNow || out.length > 0)) {
    out.unshift({ ...base, kind: 'carrierBooked', key: 'carrierBooked', data: { pro } })
  }
  return enabled(out)
}

// ── ShipmentDocument ────────────────────────────────────────────────────────

export function documentEvents(oldImg: Img, newImg: Img): IntakeThreadEvent[] {
  if (!newImg || str(newImg.type) !== 'POD') return []
  const status = str(newImg.status) ?? 'ACTIVE'
  if (status !== 'ACTIVE') return []
  if (oldImg && (str(oldImg.status) ?? 'ACTIVE') === 'ACTIVE' && str(oldImg.type) === 'POD') return []
  const shipmentId = str(newImg.shipmentId)
  if (!shipmentId) return []
  return enabled([{ kind: 'podReceived', key: 'podReceived', intakeId: null, shipmentId, data: { pro: null } }])
}

// ── Invoice ─────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

export function invoiceEvents(oldImg: Img, newImg: Img): IntakeThreadEvent[] {
  if (!newImg) return []
  const id = str(newImg.id)
  const shipmentId = str(newImg.shipmentId)
  if (!id || !shipmentId || str(newImg.status) === 'VOID') return []
  const out: IntakeThreadEvent[] = []
  const data = { pro: str(newImg.shipmentNumber), invoice: str(newImg.number) ?? id }
  if (!oldImg) out.push({ kind: 'releasedToBilling', key: 'releasedToBilling', intakeId: null, shipmentId, data })
  const sentBefore = num(oldImg?.sentCount) + (str(oldImg?.markedSentAt) ? 1 : 0) + (str(oldImg?.sentAt) && !num(oldImg?.sentCount) ? 1 : 0)
  const sentAfter = num(newImg.sentCount) + (str(newImg.markedSentAt) ? 1 : 0) + (str(newImg.sentAt) && !num(newImg.sentCount) ? 1 : 0)
  if (sentAfter > sentBefore) {
    out.push({ kind: 'invoiceSent', key: `invoiceSent:${id}:${sentAfter}`, intakeId: null, shipmentId, data: { ...data, resend: sentAfter > 1 ? 'yes' : null } })
  }
  return enabled(out)
}

// ── Finding the thread ──────────────────────────────────────────────────────

/** How far apart the e-mail's Date (Slack's file timestamp) and the bridge's receivedAt may be. They are normally identical. */
export const THREAD_MATCH_SECONDS = 180

export interface SlackEmailMessage {
  ts?: string
  thread_ts?: string
  files?: Array<{ filetype?: string; mode?: string; subject?: string; title?: string; timestamp?: number; from?: Array<{ address?: string }> }>
}

export interface ThreadProbe { subject?: unknown; fromEmail?: unknown; receivedAt?: unknown }

function subjectsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // One side cut short (a long subject) still reads as the same line.
  return Math.min(a.length, b.length) >= 20 && (a.startsWith(b) || b.startsWith(a))
}

/** The Slack message (a top-level post of Slack's e-mail integration) that carries this intake e-mail, or null. */
export function findThreadMessage(messages: SlackEmailMessage[], probe: ThreadProbe): SlackEmailMessage | null {
  const at = Date.parse(String(probe.receivedAt ?? ''))
  const subject = dupSubjectKey(str(probe.subject))
  if (!Number.isFinite(at) || !subject) return null
  const from = (str(probe.fromEmail) ?? '').toLowerCase()
  let best: { m: SlackEmailMessage; score: number } | null = null
  for (const m of messages) {
    if (!m.ts || (m.thread_ts && m.thread_ts !== m.ts)) continue
    for (const f of m.files ?? []) {
      if (f.filetype !== 'email' && f.mode !== 'email') continue
      if (typeof f.timestamp !== 'number') continue
      const drift = Math.abs(f.timestamp * 1000 - at) / 1000
      if (drift > THREAD_MATCH_SECONDS) continue
      if (!subjectsMatch(dupSubjectKey(f.subject ?? f.title ?? ''), subject)) continue
      const fromHit = !!from && (f.from ?? []).some((x) => (x.address ?? '').toLowerCase() === from)
      const score = (fromHit ? 1000 : 0) - drift
      if (!best || score > best.score) best = { m, score }
    }
  }
  return best?.m ?? null
}

// ── Messages ────────────────────────────────────────────────────────────────

/** "ryne@bcatcorp.com" → "Ryne"; "dennis.k@…" → "Dennis K". */
export function personName(email: string | null | undefined): string {
  const s = str(email)
  if (!s) return 'Someone'
  const local = s.includes('@') ? s.slice(0, s.indexOf('@')) : s
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || 'Someone'
}

/** Slack mrkdwn escaping for text we did not write. */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface MessageContext {
  pro: string | null
  shipmentUrl: string | null
  carrierName?: string | null
}

/** The thread reply for an event. Never carries money. */
export function threadMessage(e: IntakeThreadEvent, ctx: MessageContext): string | null {
  const pro = ctx.pro ?? e.data.pro ?? null
  const proText = pro ? `PRO *${esc(pro)}*` : 'the shipment'
  const link = ctx.shipmentUrl ? ` · <${ctx.shipmentUrl}|Open in BCAT Ops>` : ''
  switch (e.kind) {
    case 'duplicate': {
      const ref = e.data.ref ? ` (reference ${esc(e.data.ref)})` : ''
      const who = e.data.customer ? ` for ${esc(e.data.customer)}` : ''
      return `:warning: Possible duplicate: this tender matches PRO ${esc(e.data.pros ?? '')}${who}${ref}. Check before building it.`
    }
    case 'created':
      return `:white_check_mark: Shipment created: ${proText} by ${personName(e.data.by)}${link}`
    case 'dismissed': {
      const note = e.data.note ? `: ${esc(e.data.note)}` : ''
      return e.data.deleted
        ? `:wastebasket: Deleted from Intake by ${personName(e.data.by)}${note}`
        : `:no_entry_sign: Dismissed from Intake by ${personName(e.data.by)}${note}`
    }
    case 'carrierBooked': {
      const carrier = str(ctx.carrierName)
      if (!carrier) return null
      return `:truck: Carrier booked on ${proText}: ${esc(carrier)}`
    }
    case 'pickedUp':
      return `:package: ${proText} picked up`
    case 'delivered':
      return `:checkered_flag: ${proText} delivered`
    case 'podReceived':
      return `:page_facing_up: POD received for ${proText}`
    case 'releasedToBilling':
      return `:receipt: ${proText} released to billing`
    case 'invoiceSent': {
      const inv = e.data.invoice ? `Invoice *${esc(e.data.invoice)}*` : 'Invoice'
      return `:outbox_tray: ${inv} ${e.data.resend ? 'sent again' : 'sent'} for ${proText}`
    }
  }
}
