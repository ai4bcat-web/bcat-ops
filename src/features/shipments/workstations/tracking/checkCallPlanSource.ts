import type { CheckCallPlan, CheckCallPlanSource } from '@/lib/checkCallPlan'
import { normalizeTrackingAutomation, resolveAutomation } from '@/lib/trackingAutomation'
import type { CustomerRecord, ShipmentLoad, TmsSettings } from '@/types/tms'

export type { CheckCallPlanSource }

export interface ResolvedCheckCallPlan {
  plan: CheckCallPlan
  source: CheckCallPlanSource
  sourceName: string | null
}

/**
 * Resolve the effective check-call plan for a load the same way the backend does,
 * but also report where it came from so the Tracking page can say "inherited from
 * customer", "Division default — WEST" or "overridden for this shipment".
 * `division` is the shipment's revSubdivision/revDivision (a division plan sits
 * between the customer's and the org's).
 */
export function resolveCheckCallPlanWithSource(
  load: ShipmentLoad | null | undefined,
  customer: CustomerRecord | null | undefined,
  settings: TmsSettings | null | undefined,
  division?: { revDivision?: string | null; revSubdivision?: string | null } | null,
): ResolvedCheckCallPlan {
  const { plan, planSource } = resolveAutomation({
    settings,
    customer,
    load,
    revDivision: division?.revDivision,
    revSubdivision: division?.revSubdivision,
  })
  switch (planSource) {
    case 'customer':
      return { plan, source: planSource, sourceName: customer?.name ?? null }
    case 'division': {
      const divisions = normalizeTrackingAutomation(settings?.trackingAutomation).divisions
      const code = [division?.revSubdivision, division?.revDivision]
        .map((c) => String(c ?? '').trim())
        .find((c) => c && divisions[c]?.plan)
      return { plan, source: planSource, sourceName: code ? `Division default — ${code}` : null }
    }
    case 'org':
      return { plan, source: planSource, sourceName: 'BCAT' }
    default:
      return { plan, source: planSource, sourceName: null }
  }
}
