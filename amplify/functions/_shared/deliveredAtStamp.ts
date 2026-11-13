import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { lastDeliveryActual } from '../../../src/lib/deliveredAt'

/**
 * "deliveredAt has never been written". Shipments are created with `deliveredAt: null`, so the
 * attribute exists as a NULL and `attribute_not_exists` alone refuses every stamp — which is how
 * 20027 went Delivered with no delivered date (Ryne 2026-11-12). Both writers that stamp it use this.
 * Pairs with an expression that already names `#deliveredAt` (the SET of the stamp itself).
 */
export const DELIVERED_AT_UNSET_CONDITION = 'attribute_not_exists(#deliveredAt) OR attribute_type(#deliveredAt, :deliveredAtNullType)'

export function deliveredAtUnsetGuard<T extends { ExpressionAttributeValues: Record<string, AttributeValue> }>(expression: T): T & { ConditionExpression: string } {
  return {
    ...expression,
    ExpressionAttributeValues: { ...expression.ExpressionAttributeValues, ':deliveredAtNullType': { S: 'NULL' } },
    ConditionExpression: DELIVERED_AT_UNSET_CONDITION,
  }
}

type StopLike = { type?: string | null; arrivedAt?: string | null; departedAt?: string | null }

/**
 * When a shipment that just became DELIVERED was delivered: the loads' own stamps, else the latest
 * actual time at a delivery stop (departure, else arrival), else `fallback` (the time of the change).
 */
export function deliveredAtFor(loads: readonly { deliveredAt?: unknown; stops?: unknown }[], fallback: string): string {
  const stamps = loads.map((l) => (typeof l.deliveredAt === 'string' ? l.deliveredAt : '')).filter(Boolean).sort()
  if (stamps.length) return stamps[stamps.length - 1]
  const stops = loads.flatMap((l) => (Array.isArray(l.stops) ? (l.stops as StopLike[]) : parseStops(l.stops)))
  return lastDeliveryActual(stops) ?? fallback
}

function parseStops(raw: unknown): StopLike[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StopLike[]) : []
  } catch {
    return []
  }
}
