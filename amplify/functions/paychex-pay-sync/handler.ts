/**
 * paychex-pay-sync handler.
 *
 * Flow: OAuth (client credentials) → latest CLOSED pay period → per-worker gross pay →
 * match worker name to an app Driver → upsert DriverPayPeriod (source PAYCHEX).
 *
 * Paychex's exact JSON shapes vary by account/version, so field extraction is
 * defensive and the raw responses are logged on the first runs — check CloudWatch
 * to confirm the mapping, then we tighten it. Idempotent: a deterministic id per
 * (driver, period) means re-runs overwrite rather than duplicate.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const CLIENT_ID    = process.env.PAYCHEX_CLIENT_ID
const CLIENT_SECRET = process.env.PAYCHEX_CLIENT_SECRET
const COMPANY_ID   = process.env.PAYCHEX_COMPANY_ID
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const PAY_TABLE    = process.env.PAY_TABLE_NAME!
const API_BASE     = process.env.PAYCHEX_API_BASE ?? 'https://api.paychex.com'

const normName = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[$,]/g, '')) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}
const pick = <T = unknown>(o: Record<string, unknown> | undefined, ...keys: string[]): T | undefined => {
  if (!o) return undefined
  for (const k of keys) if (o[k] != null) return o[k] as T
  return undefined
}

async function token(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID!, client_secret: CLIENT_SECRET! }),
  })
  if (!res.ok) throw new Error(`Paychex token ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = (await res.json()) as { access_token?: string }
  if (!j.access_token) throw new Error('Paychex token: no access_token in response')
  return j.access_token
}

async function api(path: string, tok: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Paychex GET ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}
const listOf = (j: unknown): Record<string, unknown>[] => {
  if (Array.isArray(j)) return j as Record<string, unknown>[]
  const c = (j as { content?: unknown })?.content
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : []
}

export const handler = async () => {
  if (!CLIENT_ID || !CLIENT_SECRET || !COMPANY_ID) {
    console.warn('[paychex-pay-sync] not configured (client id/secret/company id) — skipping')
    return { ok: false, skipped: 'not-configured' }
  }

  const tok = await token()

  // 1) Latest CLOSED pay period (endDate in the past). Newest first.
  const periods = listOf(await api(`/companies/${COMPANY_ID}/payperiods`, tok))
  console.log('[paychex-pay-sync] pay periods:', JSON.stringify(periods.slice(0, 3)))
  const today = new Date().toISOString().slice(0, 10)
  const closed = periods
    .map((p) => ({
      id:    String(pick(p, 'payPeriodId', 'id') ?? ''),
      start: String(pick(p, 'startDate', 'periodStartDate', 'start') ?? '').slice(0, 10),
      end:   String(pick(p, 'endDate', 'periodEndDate', 'end') ?? '').slice(0, 10),
    }))
    .filter((p) => p.id && p.end && p.end < today)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
  const period = closed[0]
  if (!period) { console.warn('[paychex-pay-sync] no closed pay period found'); return { ok: true, written: 0 } }
  console.log('[paychex-pay-sync] using period', period)

  // 2) Per-worker gross for that period (checks). Defensive field extraction.
  const checks = listOf(await api(`/companies/${COMPANY_ID}/payperiods/${period.id}/checks`, tok))
  console.log('[paychex-pay-sync] checks sample:', JSON.stringify(checks.slice(0, 2)))

  // 3) Drivers (match by name).
  const drivers = (await dynamo.send(new ScanCommand({ TableName: DRIVER_TABLE, ProjectionExpression: 'id, #n', ExpressionAttributeNames: { '#n': 'name' } }))).Items ?? []
  const driverByName = new Map<string, string>()
  for (const d of drivers) driverByName.set(normName(String(d.name ?? '')), String(d.id))

  const now = new Date().toISOString()
  let written = 0
  const unmatched: string[] = []

  for (const chk of checks) {
    const worker = (pick<Record<string, unknown>>(chk, 'worker', 'employee') ?? chk) as Record<string, unknown>
    const name = String(
      pick(worker, 'name', 'displayName') ??
      [pick(worker, 'firstName', 'givenName'), pick(worker, 'lastName', 'familyName')].filter(Boolean).join(' '),
    )
    const gross = num(pick(chk, 'grossPay', 'gross', 'grossAmount', 'grossEarnings'))
    const driverId = driverByName.get(normName(name))

    if (!driverId) { if (name.trim()) unmatched.push(name); continue }
    if (gross == null) { console.warn('[paychex-pay-sync] no gross for', name); continue }

    await dynamo.send(new PutCommand({
      TableName: PAY_TABLE,
      Item: {
        id:          `paychex-${driverId}-${period.start}`,   // deterministic → idempotent
        __typename:  'DriverPayPeriod',
        driverId,
        periodStart: period.start,
        periodEnd:   period.end,
        grossPay:    Math.round(gross * 100) / 100,
        source:      'PAYCHEX',
        notes:       `Synced from Paychex ${now.slice(0, 10)}`,
        createdAt:   now,
        updatedAt:   now,
      },
    }))
    written++
  }

  if (unmatched.length) console.warn('[paychex-pay-sync] unmatched workers (no driver by name):', unmatched.join(', '))
  console.log(`[paychex-pay-sync] wrote ${written} pay records for ${period.start}–${period.end}`)
  return { ok: true, period: `${period.start}–${period.end}`, written, unmatched }
}
