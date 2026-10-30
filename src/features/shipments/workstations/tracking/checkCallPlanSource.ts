import {
  DEFAULT_CHECK_CALL_PLAN,
  normalizeCheckCallPlan,
  type CheckCallPlan,
} from '@/lib/checkCallPlan'
import type { CustomerRecord, ShipmentLoad, TmsSettings } from '@/types/tms'

export type CheckCallPlanSource = 'load' | 'customer' | 'org' | 'default'

export interface ResolvedCheckCallPlan {
  plan: CheckCallPlan
  source: CheckCallPlanSource
  sourceName: string | null
}

/**
 * Resolve the effective check-call plan for a load the same way the backend does,
 * but also report where it came from so the Tracking page can say "inherited from
 * customer" or "overridden for this shipment".
 */
export function resolveCheckCallPlanWithSource(
  load: ShipmentLoad | null | undefined,
  customer: CustomerRecord | null | undefined,
  settings: TmsSettings | null | undefined,
): ResolvedCheckCallPlan {
  const own = normalizeCheckCallPlan(load?.checkCallPlan)
  if (own) {
    return { plan: own, source: 'load', sourceName: null }
  }
  const cust = normalizeCheckCallPlan(customer?.checkCallPlan)
  if (cust) {
    return { plan: cust, source: 'customer', sourceName: customer?.name ?? null }
  }
  const org = normalizeCheckCallPlan(settings?.defaultCheckCallPlan)
  if (org) {
    return { plan: org, source: 'org', sourceName: 'BCAT' }
  }
  return {
    plan: DEFAULT_CHECK_CALL_PLAN,
    source: 'default',
    sourceName: null,
  }
}
