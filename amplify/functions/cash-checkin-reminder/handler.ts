/**
 * cash-checkin-reminder Lambda — see resource.ts. Reads the CashSettings "default" row and
 * the CashCheckIn table directly (same pattern as appt-report) and posts one Slack message.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TZ = 'America/Chicago'
const PAGE_URL = 'https://ops.bcatcorp.com/finance/cash-checkin'

const chicagoDate = (d = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const chicagoHour = (): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))

const daysBetween = (a: string, b: string): number => {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/**
 * The payroll date a reminder is for on `today`, or null. Mirrors reminderDuePayroll in
 * src/lib/cashCheckIn.ts (Lambdas do not import from src/): payroll recurs every 14 days
 * from the anchor, the reminder goes out the morning after, and it is suppressed once a
 * check-in dated on or after that payroll exists.
 */
export function reminderDuePayroll(anchor: string, checkinDates: string[], today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null
  const sinceAnchor = daysBetween(anchor, today) - 1
  if (sinceAnchor < 0 || sinceAnchor % 14 !== 0) return null
  const [y, m, d] = anchor.split('-').map(Number)
  const payroll = new Date(Date.UTC(y, m - 1, d + sinceAnchor)).toISOString().slice(0, 10)
  return checkinDates.some((c) => c >= payroll) ? null : payroll
}

const longDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })
}

export function reminderText(payroll: string): string {
  return (
    `Payroll ran ${longDate(payroll)} — time for the cash check-in. ` +
    `Log cash on hand, AR, AP, cards owed and month-to-date profit for BCAT, Ivan and Amazon: ${PAGE_URL}`
  )
}

export const handler = async (): Promise<{ ok: boolean; posted?: boolean; reason?: string }> => {
  const token = process.env.SLACK_BOT_TOKEN
  const settingsTable = process.env.SETTINGS_TABLE_NAME
  const checkinTable = process.env.CHECKIN_TABLE_NAME
  if (!token || !settingsTable || !checkinTable) {
    console.warn('[cash-checkin-reminder] not configured (token/tables) — skipping')
    return { ok: false, reason: 'not configured' }
  }
  // Two UTC crons cover both DST offsets; only the one that is 09:00 in Chicago posts.
  if (chicagoHour() !== 9) return { ok: true, posted: false, reason: 'not 09:00 Chicago' }

  const settings = (await dynamo.send(new GetCommand({ TableName: settingsTable, Key: { id: 'default' } }))).Item as
    | { payrollAnchor?: string | null; slackChannel?: string | null; lastReminderFor?: string | null }
    | undefined
  const anchor = settings?.payrollAnchor ?? ''
  const channel = settings?.slackChannel ?? ''
  if (!anchor || !channel) return { ok: true, posted: false, reason: 'reminder not set up on the page' }

  const dates: string[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const page = await dynamo.send(new ScanCommand({ TableName: checkinTable, ProjectionExpression: '#d', ExpressionAttributeNames: { '#d': 'date' }, ExclusiveStartKey }))
    for (const item of page.Items ?? []) if (typeof item.date === 'string') dates.push(item.date)
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)

  const payroll = reminderDuePayroll(anchor, dates, chicagoDate())
  if (!payroll) return { ok: true, posted: false, reason: 'nothing due' }
  // Re-run guard (manual invoke, retried event): one post per payroll, ever.
  if (settings?.lastReminderFor === payroll) return { ok: true, posted: false, reason: 'already reminded' }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text: reminderText(payroll), unfurl_links: false }),
  })
  const json = (await res.json()) as { ok: boolean; error?: string }
  if (!json.ok) {
    console.error('[cash-checkin-reminder] chat.postMessage failed', json.error)
    return { ok: false, reason: json.error ?? 'post failed' }
  }
  await dynamo.send(new UpdateCommand({
    TableName: settingsTable, Key: { id: 'default' },
    UpdateExpression: 'SET lastReminderFor = :p', ExpressionAttributeValues: { ':p': payroll },
  }))
  return { ok: true, posted: true }
}
