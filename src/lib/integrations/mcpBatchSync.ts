/**
 * The two pieces every MyCarrierPackets writer shares: the LIVE gate and the compare-and-set
 * Carrier update. The walking itself is `mcpPull.ts`.
 */
import { isNeutered } from './health'

type Row = Record<string, unknown>

/** The CAS UpdateItem for a patch: SET only the changed fields, guarded by the `updatedAt` that was read. */
export function mcpUpdateItem(carrier: Row, patch: Row, nowIso: string) {
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' }
  const values: Record<string, unknown> = { ':now': nowIso }
  const sets = ['#updatedAt = :now']
  Object.entries(patch).forEach(([key, value], i) => {
    names[`#k${i}`] = key
    values[`:v${i}`] = value
    sets.push(`#k${i} = :v${i}`)
  })
  const prev = typeof carrier.updatedAt === 'string' ? carrier.updatedAt : null
  if (prev) values[':prev'] = prev
  return {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: `attribute_exists(id) AND ${prev ? '#updatedAt = :prev' : 'attribute_not_exists(#updatedAt)'}`,
  }
}

/**
 * Why a pull must not run, or null. The integration has to report LIVE — validated with
 * real, non-neutered credentials — so dev (and anything else without them) refuses.
 */
export function mcpSyncRefusal(
  integration: { mode?: unknown; health?: unknown } | null,
  credentials: Record<string, string | null | undefined> | null,
): string | null {
  const username = credentials?.username ?? ''
  const password = credentials?.password ?? ''
  if (!username.trim() || !password.trim()) return 'MyCarrierPackets credentials are not configured.'
  if (isNeutered(username) || isNeutered(password)) return 'MyCarrierPackets credentials are neutered on this stack.'
  if (integration?.mode !== 'LIVE' || integration.health !== 'OK') {
    return 'MyCarrierPackets does not report LIVE. Press Validate on Integrations > MyCarrierPackets first.'
  }
  return null
}
