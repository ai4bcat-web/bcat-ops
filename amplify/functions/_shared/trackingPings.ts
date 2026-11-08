/**
 * Step AO — the one server-side writer of load-keyed breadcrumbs.
 *
 * `tracking-api` (the driver's tapped link), `tms-tracking-actions` (shared-pin and
 * geocoded text replies, sim doors) and the provider webhook consumer all file fixes
 * here, so the row shape, the 90-day TTL and the duplicate rule live in one place
 * (`src/lib/trackingPings.ts` owns the shape; this file only does the DynamoDB write).
 */
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { descriptorOf } from '../../../src/lib/integrations/registry'
import { trackingPortFor, type TrackingProviderPort } from '../../../src/lib/integrations/trackingProvider'
import { pingRow, type PingInput } from '../../../src/lib/trackingPings'
import type { TrackingLinkRecord } from '../../../src/types/tms'

export interface PingDeps { ddb: DynamoDBDocumentClient; table: string }    // TRUCK_LOCATION_HISTORY_TABLE_NAME

const MAX_FIXES_PER_DELIVERY = 100

/** Conditional put: a retry of the same fix (same load, same instant) is a silent success. */
export async function putPing(deps: PingDeps, input: PingInput): Promise<'WRITTEN' | 'DUPLICATE'> {
  try {
    await deps.ddb.send(new PutCommand({
      TableName: deps.table,
      Item: pingRow(input),
      ConditionExpression: 'attribute_not_exists(locatedAt)',
    }))
    return 'WRITTEN'
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return 'DUPLICATE'
    throw err
  }
}

export interface ProviderDeliveryDeps extends PingDeps {
  getLink(token: string): Promise<TrackingLinkRecord | null>
  bumpLink(token: string, n: number, lastAtIso: string): Promise<void>
  loadClosed(loadId: string): Promise<boolean>
  /** A LIVE port, when one exists. Today none does and the stub (SIM shape only) parses. */
  port?: TrackingProviderPort
}

export interface DeliveryOutcome { accepted: number; duplicates: number; ignored: string | null }

/**
 * A provider delivery, end to end: parse → find the subscription by the reference we
 * gave the provider → refuse a closed load → file each fix. Never throws for a bad
 * delivery (a provider must not retry forever); a DynamoDB fault still propagates.
 */
export async function ingestProviderDelivery(
  deps: ProviderDeliveryDeps,
  providerKey: string,
  raw: { headers: Record<string, string | undefined>; body: string },
  nowIso: string,
): Promise<DeliveryOutcome> {
  const none = (ignored: string): DeliveryOutcome => ({ accepted: 0, duplicates: 0, ignored })
  const descriptor = descriptorOf(providerKey.toUpperCase())
  if (!descriptor || descriptor.category !== 'TRACKING') return none('unknown-provider')

  const port = deps.port ?? trackingPortFor(descriptor, {})
  const parsed = port.parseDelivery(raw)
  if (!parsed) return none('unparseable')

  const link = await deps.getLink(parsed.reference)
  if (
    !link || link.kind !== 'PROVIDER_TRACK' || link.status !== 'ACTIVE' || !link.loadId ||
    (link.provider ?? '').toLowerCase() !== providerKey.toLowerCase() ||
    Date.parse(link.expiresAt) <= Date.parse(nowIso)
  ) {
    return none('link-not-active')
  }
  if (await deps.loadClosed(link.loadId)) return none('load-closed')

  const source = `provider:${providerKey.toLowerCase()}` as const
  let accepted = 0
  let duplicates = 0
  let newest = ''
  for (const fix of parsed.fixes.slice(0, MAX_FIXES_PER_DELIVERY)) {
    const result = await putPing(deps, {
      loadId: link.loadId, at: fix.at, lat: fix.lat, lng: fix.lng, source,
      accuracyM: fix.accuracyM, speedMph: fix.speedMph, headingDeg: fix.headingDeg, refId: fix.refId, nowIso,
    })
    if (result === 'WRITTEN') {
      accepted += 1
      if (fix.at > newest) newest = fix.at
    } else {
      duplicates += 1
    }
  }
  if (accepted > 0) await deps.bumpLink(link.id, accepted, newest)
  return { accepted, duplicates, ignored: null }
}
