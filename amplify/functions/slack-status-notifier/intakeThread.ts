/**
 * Intake Slack threads: process updates posted as replies under the Slack message an intake e-mail arrived as (Ryne 2026-11-12).
 *
 * Fed by four DynamoDB streams (IntakeLoad, Shipment, ShipmentDocument, Invoice). `src/lib/intakeSlackThread.ts` turns each record
 * into zero or more events with no I/O; only an event reads anything. The rules:
 *   - fire-and-forget: nothing here throws back into the stream, and nothing here can block or undo a shipment write;
 *   - once per event: the event key is claimed on the IntakeLoad row (`slackPosted.<key>`, conditional) before posting, and released
 *     if the post fails, so a stream retry or a twin record never posts the same line twice;
 *   - threaded only (`thread_ts`, never `reply_broadcast`), and never money;
 *   - an intake with no Slack message (not every e-mail is in Slack, and nothing before this change is linked) gets nothing.
 * The thread is found once and stored on the row (`slackChannelId` / `slackThreadTs`) and copied onto the shipment it became.
 */
import {
  documentEvents,
  findThreadMessage,
  intakeLoadEvents,
  invoiceEvents,
  shipmentEvents,
  threadMessage,
  THREAD_MATCH_SECONDS,
  type IntakeThreadEvent,
  type SlackEmailMessage,
} from '../../../src/lib/intakeSlackThread'

type Row = Record<string, unknown>

export interface SlackReply { text?: string; bot_id?: string; user?: string }

export interface IntakeThreadDeps {
  getIntake: (id: string) => Promise<Row | null>
  getShipment: (id: string) => Promise<Row | null>
  getLoad: (id: string) => Promise<Row | null>
  saveThread: (intakeId: string, channel: string, ts: string) => Promise<void>
  /** Stamp the thread (and the intake id, when the shipment was linked rather than built from the row) onto the shipment. */
  copyThreadToShipment: (shipmentId: string, intakeId: string, channel: string, ts: string) => Promise<void>
  /** True when this call took the key; false when it was already taken. */
  claim: (intakeId: string, key: string) => Promise<boolean>
  release: (intakeId: string, key: string) => Promise<void>
  audit: (intakeId: string, action: string, changes: Row) => Promise<void>
  history: (channel: string, oldest: number, latest: number) => Promise<SlackEmailMessage[]>
  replies: (channel: string, ts: string) => Promise<SlackReply[]>
  post: (channel: string, threadTs: string, text: string) => Promise<void>
  botUserId: () => Promise<string | null>
  /** The intake channels (SLACK_CHANNEL_MAPPING keys). */
  channels: string[]
  /** https://ops.bcatcorp.com on main. */
  portalOrigin: string
  sleep: (ms: number) => Promise<void>
  /** Dev stack: decide and log, never post. */
  dryRun: boolean
  log: (msg: string, extra?: Row) => void
}

export interface StreamRecord {
  eventName?: string
  eventSourceARN?: string
  dynamodb?: { OldImage?: Row; NewImage?: Row }
}

/** "…:table/IntakeLoad-abc-NONE/stream/…" → "IntakeLoad". */
export function tableOf(arn: string | undefined): string | null {
  const m = /:table\/([A-Za-z]+)-/.exec(arn ?? '')
  return m ? m[1]! : null
}

export function eventsFor(table: string | null, oldImg: Row | null, newImg: Row | null): IntakeThreadEvent[] {
  switch (table) {
    case 'IntakeLoad': return intakeLoadEvents(oldImg, newImg)
    case 'Shipment': return shipmentEvents(oldImg, newImg)
    case 'ShipmentDocument': return documentEvents(oldImg, newImg)
    case 'Invoice': return invoiceEvents(oldImg, newImg)
    default: return []
  }
}

/** A new e-mail is in Slack seconds after the bridge stages it, sometimes a little later. Only a line posted at staging waits. */
const ARRIVAL_WAITS_MS = [0, 20_000, 40_000]

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

async function resolveThread(deps: IntakeThreadDeps, intake: Row, waitForPost: boolean): Promise<{ channel: string; ts: string } | null> {
  const channel = str(intake.slackChannelId)
  const ts = str(intake.slackThreadTs)
  if (channel && ts) return { channel, ts }
  const at = Date.parse(String(intake.receivedAt ?? ''))
  if (!Number.isFinite(at) || !str(intake.subject) || deps.channels.length === 0) return null
  const oldest = at / 1000 - THREAD_MATCH_SECONDS
  // A Slack post is never earlier than the e-mail; six hours covers a slow forward.
  const latest = at / 1000 + 6 * 3600
  for (const wait of waitForPost ? ARRIVAL_WAITS_MS : [0]) {
    if (wait) await deps.sleep(wait)
    for (const c of deps.channels) {
      const found = findThreadMessage(await deps.history(c, oldest, latest), intake)
      if (found?.ts) {
        await deps.saveThread(String(intake.id), c, found.ts)
        return { channel: c, ts: found.ts }
      }
    }
  }
  return null
}

async function carrierNameOf(deps: IntakeThreadDeps, shipment: Row | null): Promise<string | null> {
  const ids = Array.isArray(shipment?.loadIds) ? (shipment!.loadIds as unknown[]).filter((x): x is string => typeof x === 'string') : []
  for (const id of ids) {
    const load = await deps.getLoad(id)
    const name = str(load?.carrierName)
    if (name) return name
  }
  return null
}

/** True when this exact line (or, for a dismissal, a "Shipment created" line) is already in the thread from our bot. */
async function alreadyInThread(deps: IntakeThreadDeps, thread: { channel: string; ts: string }, text: string, e: IntakeThreadEvent): Promise<boolean> {
  const me = await deps.botUserId()
  const ours = (await deps.replies(thread.channel, thread.ts)).filter((r) => (me && r.user === me) || !!r.bot_id)
  return ours.some((r) => r.text === text || (e.kind === 'dismissed' && (r.text ?? '').startsWith(':white_check_mark: Shipment created')))
}

export async function processEvent(deps: IntakeThreadDeps, e: IntakeThreadEvent): Promise<'posted' | 'skipped' | 'failed'> {
  let shipment: Row | null = e.shipmentId ? await deps.getShipment(e.shipmentId) : null
  const intakeId = e.intakeId ?? str(shipment?.intakeLoadId)
  if (!intakeId) return 'skipped'
  const intake = await deps.getIntake(intakeId)
  if (!intake) return 'skipped'
  const posted = (intake.slackPosted && typeof intake.slackPosted === 'object') ? (intake.slackPosted as Row) : {}
  if (posted[e.key]) return 'skipped'

  const thread = await resolveThread(deps, intake, e.kind === 'duplicate')
  if (!thread) {
    deps.log('no Slack thread for intake', { intakeId, kind: e.kind })
    return 'skipped'
  }
  const shipmentId = e.shipmentId ?? str(intake.shipmentId)
  if (!shipment && shipmentId) shipment = await deps.getShipment(shipmentId)
  if (e.kind === 'created' && shipmentId) {
    await deps.copyThreadToShipment(shipmentId, intakeId, thread.channel, thread.ts).catch((err: unknown) =>
      deps.log('thread not copied to shipment', { shipmentId, error: String(err) }))
  }
  const text = threadMessage(e, {
    pro: str(shipment?.number) ?? str(intake.shipmentNumber),
    shipmentUrl: shipmentId ? `${deps.portalOrigin.replace(/\/$/, '')}/tms/shipments/${encodeURIComponent(shipmentId)}` : null,
    carrierName: e.kind === 'carrierBooked' ? await carrierNameOf(deps, shipment) : null,
  })
  if (!text) return 'skipped'
  if (deps.dryRun) {
    deps.log('dry run: would post', { intakeId, kind: e.kind, channel: thread.channel, text })
    return 'skipped'
  }
  if (!(await deps.claim(intakeId, e.key))) return 'skipped'
  try {
    if (await alreadyInThread(deps, thread, text, e)) return 'skipped'
    await deps.post(thread.channel, thread.ts, text)
    return 'posted'
  } catch (err) {
    deps.log('Slack post failed', { intakeId, kind: e.kind, error: String(err) })
    await deps.release(intakeId, e.key).catch(() => {})
    await deps.audit(intakeId, 'INTAKE_SLACK_POST_FAILED', { kind: e.kind, key: e.key, error: String(err).slice(0, 300) }).catch(() => {})
    return 'failed'
  }
}

/** One stream batch. Never throws: a Slack line is never worth blocking the shard. */
export async function handleIntakeThreadStream(
  deps: IntakeThreadDeps,
  records: StreamRecord[],
  unmarshall: (img: Row) => Row,
): Promise<{ posted: number; skipped: number; failed: number }> {
  const out = { posted: 0, skipped: 0, failed: 0 }
  for (const r of records) {
    try {
      const oldImg = r.dynamodb?.OldImage ? unmarshall(r.dynamodb.OldImage) : null
      const newImg = r.eventName === 'REMOVE' ? null : (r.dynamodb?.NewImage ? unmarshall(r.dynamodb.NewImage) : null)
      for (const e of eventsFor(tableOf(r.eventSourceARN), oldImg, newImg)) {
        out[await processEvent(deps, e)]++
      }
    } catch (err) {
      out.failed++
      deps.log('intake thread record failed', { error: String(err) })
    }
  }
  return out
}
