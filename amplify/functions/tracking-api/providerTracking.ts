/**
 * Step AO — the tracking-provider delivery consumer behind `POST /api/webhooks/<provider>`.
 *
 * `webhookRoute` has already verified the signature and filed the replay receipt by the
 * time this runs. Everything here is the thin Dynamo-backed wrapper around the shared
 * `ingestProviderDelivery`: it reads the TrackingLink row the provider echoed back,
 * checks the load is still open, files each fix as a breadcrumb and bumps the link's
 * counters. A bad delivery is never an error (a provider must not retry forever); only a
 * DynamoDB fault propagates, and `webhookRoute` swallows that too.
 */
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { descriptorOf } from '../../../src/lib/integrations/registry'
import { ingestProviderDelivery, type DeliveryOutcome } from '../_shared/trackingPings'
import type { TrackingLinkRecord } from '../../../src/types/tms'

export interface TrackingConsumeDeps {
  ddb: DynamoDBDocumentClient
  linkTable: string
  loadTable: string
  historyTable: string
}

/** A load is done with tracking once the freight is off the truck. */
const CLOSED_LOAD_STATUSES: readonly string[] = ['DELIVERED', 'INVOICING', 'CANCELED']

/** True when this registry key is a tracking provider (the only kind whose deliveries carry positions). */
export function isTrackingProvider(key: string): boolean {
  return descriptorOf(key.toUpperCase())?.category === 'TRACKING'
}

export async function consumeTrackingDelivery(
  deps: TrackingConsumeDeps,
  providerKey: string,
  raw: { headers: Record<string, string | undefined>; body: string },
  nowIso: string,
): Promise<DeliveryOutcome> {
  return ingestProviderDelivery(
    {
      ddb: deps.ddb,
      table: deps.historyTable,
      async getLink(token) {
        const out = await deps.ddb.send(new GetCommand({ TableName: deps.linkTable, Key: { id: token } }))
        return (out.Item as TrackingLinkRecord | undefined) ?? null
      },
      async bumpLink(token, n, lastAtIso) {
        await deps.ddb.send(new UpdateCommand({
          TableName: deps.linkTable,
          Key: { id: token },
          UpdateExpression: 'SET lastPingAt = :at, updatedAt = :now ADD pingCount :n',
          ExpressionAttributeValues: { ':at': lastAtIso, ':now': nowIso, ':n': n },
        }))
      },
      async loadClosed(loadId) {
        const out = await deps.ddb.send(new GetCommand({ TableName: deps.loadTable, Key: { id: loadId } }))
        const status = out.Item?.status
        // A load that no longer exists has nothing to track either.
        return !out.Item || (typeof status === 'string' && CLOSED_LOAD_STATUSES.includes(status))
      },
    },
    providerKey,
    raw,
    nowIso,
  )
}
