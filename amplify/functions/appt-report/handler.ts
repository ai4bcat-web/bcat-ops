/**
 * appt-report Lambda — see resource.ts. Scans the Load table directly (same pattern as
 * compliance-scanner) and posts one digest message to the global channel.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TZ = 'America/Chicago'

interface Stop {
  type: 'pickup' | 'delivery'
  appt?: string
  apptType?: string
  apptStatus?: string | null
  apptProofs?: { request?: string | null; e2open?: string | null; email?: string | null } | null
  apptMoveRequested?: boolean
  name?: string
  city?: string
}
interface LoadRow {
  id: string
  customer?: string
  aljexId?: string
  stops?: unknown
  rateConfirmKey?: string
  pickupAppt?: string; pickupApptType?: string
  deliveryAppt?: string; deliveryApptType?: string
  originName?: string; destinationName?: string
}

const chicagoDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso))
const chicagoHour = (): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
const chicagoWeekday = (d: Date): number => {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
}

/** The next 5 business days (Chicago), starting today if today is one. */
export function businessDays(now = new Date()): string[] {
  const out: string[] = []
  const d = new Date(now)
  while (out.length < 5) {
    const wd = chicagoWeekday(d)
    if (wd >= 1 && wd <= 5) out.push(chicagoDate(d.toISOString()))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

const unwrap = (v: unknown): unknown => {
  for (let i = 0; i < 4 && typeof v === 'string'; i++) { try { v = JSON.parse(v as string) } catch { break } }
  return v
}

const hasTime = (iso?: string): boolean => {
  if (!iso) return false
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(iso))
  const h = p.find((x) => x.type === 'hour')?.value, m = p.find((x) => x.type === 'minute')?.value
  return !(h === '0' && m === '00') && !(h === '00' && m === '00')
}

/** Mirrors src/lib/apptStatus.ts apptWorkflowStatus, trimmed to what the report needs. */
export function statusOf(stop: Stop, load: LoadRow): string {
  if (!/batory/i.test(load.customer ?? '')) return load.rateConfirmKey ? 'confirmed' : 'RATECON NEEDED'
  if (stop.apptStatus) return stop.apptStatus === 'confirmed' ? 'confirmed'
    : { need_request: 'NEED TO REQUEST', need_book: 'NEED TO BOOK', requested: 'REQUESTED', change_needed: 'CHANGE NEEDED' }[stop.apptStatus] ?? stop.apptStatus
  if (stop.apptMoveRequested) return 'CHANGE NEEDED'
  const booked = (stop.apptType ?? 'exact') !== 'tbd' &&
    (stop.apptType === 'fcfs' || stop.apptType === 'range' || hasTime(stop.appt))
  if (booked) return (stop.apptProofs?.e2open && stop.apptProofs?.email) ? 'confirmed' : 'REQUESTED'
  return stop.type === 'delivery' ? 'NEED TO BOOK' : 'NEED TO REQUEST'
}

export const handler = async (event?: { force?: boolean }) => {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
  const CHANNEL = process.env.SLACK_GLOBAL_CHANNEL_ID
  const LOAD_TABLE = process.env.LOAD_TABLE_NAME
  if (!SLACK_BOT_TOKEN || !CHANNEL || !LOAD_TABLE) {
    console.warn('[appt-report] not configured (token/channel/table) — skipping')
    return { ok: false, error: 'not configured' }
  }
  // Two UTC crons cover DST; only the one landing on 3 PM Chicago posts.
  if (!event?.force && chicagoHour() !== 15) return { ok: true, skipped: 'not 3pm Chicago' }

  const days = businessDays()
  const daySet = new Set(days)

  const loads: LoadRow[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const page = await dynamo.send(new ScanCommand({ TableName: LOAD_TABLE, ExclusiveStartKey }))
    loads.push(...(page.Items as LoadRow[] ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (ExclusiveStartKey)

  const lines: string[] = []
  for (const load of loads) {
    const parsed = unwrap(load.stops)
    const stops: Stop[] = Array.isArray(parsed) && parsed.length ? parsed as Stop[] : [
      { type: 'pickup', appt: load.pickupAppt, apptType: load.pickupApptType, name: load.originName },
      { type: 'delivery', appt: load.deliveryAppt, apptType: load.deliveryApptType, name: load.destinationName },
    ]
    for (const stop of stops) {
      if (!stop.appt) continue
      const day = chicagoDate(stop.appt)
      if (!daySet.has(day)) continue
      const st = statusOf(stop, load)
      if (st === 'confirmed') continue
      const kind = stop.type === 'delivery' ? 'DEL' : 'PU'
      lines.push(`• ${day} ${kind} — *${st}* — ${[load.aljexId ? `Pro# ${load.aljexId}` : null, load.customer, stop.name || stop.city].filter(Boolean).join(' · ')}`)
    }
  }
  lines.sort()

  const text = lines.length
    ? [`:clipboard: *Appointment report — ${lines.length} appt${lines.length === 1 ? '' : 's'} in the next 5 business days still not confirmed*`, ...lines].join('\n')
    : ':white_check_mark: *Appointment report* — every appointment in the next 5 business days is confirmed.'

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
  })
  const json = await res.json() as { ok: boolean; error?: string }
  if (!json.ok) { console.error('[appt-report] post failed', json.error); return { ok: false, error: json.error } }
  return { ok: true, count: lines.length }
}
