/**
 * BROKERAGE_REP_ROLLUP: the only door to the per-rep Brokerage figures.
 *
 * tms-dashboard-rollup writes one private S3 object per month, `rollups/brokerage/<YYYY-MM>.json`, in the
 * DataSafety bucket (no client can read that bucket; DashboardRollup, by contrast, is readable by every
 * signed-in user, which is why the rep split is NOT stored there). This action reads the months asked for
 * and filters them by the caller BEFORE they leave the Lambda (`brokerageAccessOf` / `filterRepMonth`):
 *   - owner / ADMIN / `page-dashboard`  -> every rep, as stored;
 *   - an active sales rep with a profile -> only their own rep key (profile id = Cognito username =
 *     Shipment.salesRepId), so every total the page builds from the response is their own;
 *   - anyone else (a rep with no profile, other staff roles)  -> refused.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  brokerageAccessOf,
  filterRepMonth,
  type BrokerageProfile,
  type BrokerageRepMonth,
} from '../../../src/lib/brokerageAccess'
import { getCallerEmail, getGroups, getById, s3, USER_PROFILE_TABLE_NAME, type AppSyncIdentity, type Row } from './store'

export const BROKERAGE_ROLLUP_PREFIX = 'rollups/brokerage/'
export const MAX_REP_ROLLUP_MONTHS = 36
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export const brokerageRollupKey = (month: string): string => `${BROKERAGE_ROLLUP_PREFIX}${month}.json`

function monthsOf(from: string, to: string): string[] {
  if (!MONTH.test(from) || !MONTH.test(to)) throw new Error('from and to must be YYYY-MM')
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const out: string[] = []
  let [y, m] = lo.split('-').map(Number) as [number, number]
  const [hy, hm] = hi.split('-').map(Number) as [number, number]
  while (y < hy || (y === hy && m <= hm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    if (out.length > MAX_REP_ROLLUP_MONTHS) throw new Error(`at most ${MAX_REP_ROLLUP_MONTHS} months per request`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/** The caller's staff row: the Cognito username first (what salesRepId holds), the sub as a fallback. */
async function profileOf(identity: AppSyncIdentity): Promise<BrokerageProfile | null> {
  if (!USER_PROFILE_TABLE_NAME) return null
  for (const id of [identity.username, identity.sub]) {
    if (typeof id !== 'string' || !id) continue
    const row = await getById(USER_PROFILE_TABLE_NAME, id)
    if (row) return { id: String(row.id ?? id), role: typeof row.role === 'string' ? row.role : null, status: typeof row.status === 'string' ? row.status : null }
  }
  return null
}

async function readMonth(bucket: string, month: string): Promise<BrokerageRepMonth | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: brokerageRollupKey(month) }))
    const parsed: unknown = JSON.parse((await out.Body?.transformToString()) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || !('rep' in parsed) || !parsed.rep || typeof parsed.rep !== 'object') return null
    const computedAt = 'computedAt' in parsed ? String(parsed.computedAt ?? '') : ''
    // The object is written by tms-dashboard-rollup in exactly this shape; filterRepMonth only walks it.
    const rep = Object.fromEntries(Object.entries(parsed.rep))
    return { month, computedAt, rep }
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null
    throw err
  }
}

export async function brokerageRepRollup(identity: AppSyncIdentity | null | undefined, input: Row): Promise<Row> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  // The profile is read only when the groups do not already settle it.
  const privileged = brokerageAccessOf({ email, groups }, null).scope === 'ALL'
  const access = privileged ? { scope: 'ALL' as const, repKey: null } : brokerageAccessOf({ email, groups }, await profileOf(identity))
  if (access.scope === 'NONE') throw new Error('Forbidden: the Brokerage dashboard is for the owner, ADMIN, page-dashboard holders and sales reps with a profile')

  const bucket = process.env.DATA_SAFETY_BUCKET_NAME ?? ''
  if (!bucket) throw new Error('Brokerage rollup bucket is not configured')
  const months = monthsOf(String(input.from ?? ''), String(input.to ?? ''))
  const stored = await Promise.all(months.map((m) => readMonth(bucket, m)))
  const out: BrokerageRepMonth[] = []
  const missing: string[] = []
  stored.forEach((row, i) => {
    const filtered = row ? filterRepMonth(access, row) : null
    if (filtered) out.push(filtered)
    else missing.push(months[i])
  })
  return { scope: access.scope, repKey: access.repKey, months: out, missing } as unknown as Row
}
