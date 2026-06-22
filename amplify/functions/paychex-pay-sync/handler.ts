/**
 * paychex-pay-sync handler.
 *
 * Pulls the latest CLOSED Paychex pay period and writes ONE combined driver-cost
 * record into DriverPayPeriod under the fleet-combined sentinel driver id, so it lands
 * straight on Ivan/fleet driver cost in Finances. No per-worker matching — just the
 * total for the period.
 *
 * The total is the period's payroll total (cash requirement / gross). Paychex JSON
 * shapes vary, so extraction is defensive and the raw responses are logged on the
 * first runs — check CloudWatch to confirm we're grabbing the figure that matches your
 * Cash Requirements report, then we pin the field. Idempotent: a deterministic id per
 * period means re-runs overwrite rather than duplicate.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const CLIENT_ID     = process.env.PAYCHEX_CLIENT_ID
const CLIENT_SECRET = process.env.PAYCHEX_CLIENT_SECRET
const COMPANY_ID    = process.env.PAYCHEX_COMPANY_ID
const PAY_TABLE     = process.env.PAY_TABLE_NAME!
const API_BASE      = process.env.PAYCHEX_API_BASE ?? 'https://api.paychex.com'
// Combined fleet-wide pay sentinel — must match combinedPayDriverId('LOCAL') in the app.
const COMBINED_DRIVER_ID = 'fleet-combined:LOCAL'

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[$,]/g, '')) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}
const pick = <T = unknown>(o: Record<string, unknown> | undefined, ...keys: string[]): T | undefined => {
  if (!o) return undefined
  for (const k of keys) if (o[k] != null) return o[k] as T
  return undefined
}
const listOf = (j: unknown): Record<string, unknown>[] => {
  if (Array.isArray(j)) return j as Record<string, unknown>[]
  const c = (j as { content?: unknown })?.content
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : []
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

export const handler = async () => {
  if (!CLIENT_ID || !CLIENT_SECRET || !COMPANY_ID) {
    console.warn('[paychex-pay-sync] not configured (client id/secret/company id) — skipping')
    return { ok: false, skipped: 'not-configured' }
  }

  const tok = await token()

  // Latest CLOSED pay period (endDate in the past), newest first.
  const periods = listOf(await api(`/companies/${COMPANY_ID}/payperiods`, tok))
  console.log('[paychex-pay-sync] pay periods:', JSON.stringify(periods.slice(0, 3)))
  const today = new Date().toISOString().slice(0, 10)
  const closed = periods
    .map((p) => ({
      raw:   p,
      id:    String(pick(p, 'payPeriodId', 'id') ?? ''),
      start: String(pick(p, 'startDate', 'periodStartDate', 'start') ?? '').slice(0, 10),
      end:   String(pick(p, 'endDate', 'periodEndDate', 'end') ?? '').slice(0, 10),
    }))
    .filter((p) => p.id && p.end && p.end < today)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
  const period = closed[0]
  if (!period) { console.warn('[paychex-pay-sync] no closed pay period found'); return { ok: true, written: 0 } }
  console.log('[paychex-pay-sync] using period', { id: period.id, start: period.start, end: period.end })

  // Total payroll for the period. Prefer a period-level total; else sum the checks' gross.
  let total = num(pick(period.raw, 'cashRequirement', 'totalCashRequirement', 'netCashRequirement', 'grossPay', 'totalGross', 'totalAmount'))
  if (total == null) {
    const checks = listOf(await api(`/companies/${COMPANY_ID}/payperiods/${period.id}/checks`, tok))
    console.log('[paychex-pay-sync] checks count:', checks.length, '· sample:', JSON.stringify(checks.slice(0, 2)))
    total = Math.round(checks.reduce((s, c) => s + (num(pick(c, 'grossPay', 'gross', 'grossAmount', 'grossEarnings')) ?? 0), 0) * 100) / 100
  }
  if (!total || total <= 0) { console.warn('[paychex-pay-sync] could not determine a payroll total for', period.start); return { ok: true, written: 0 } }

  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: PAY_TABLE,
    Item: {
      id:          `paychex-combined-LOCAL-${period.start}`,   // deterministic → idempotent
      __typename:  'DriverPayPeriod',
      driverId:    COMBINED_DRIVER_ID,
      periodStart: period.start,
      periodEnd:   period.end,
      grossPay:    total,
      source:      'PAYCHEX',
      notes:       `Paychex total payroll, synced ${now.slice(0, 10)}`,
      createdAt:   now,
      updatedAt:   now,
    },
  }))

  console.log(`[paychex-pay-sync] wrote combined driver cost $${total} for ${period.start}–${period.end}`)
  return { ok: true, period: `${period.start}–${period.end}`, total }
}
