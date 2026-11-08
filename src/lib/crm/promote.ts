/** Step AB §5.5 — prospect → customer on the first shipment (pure decision). */
import { CRM_LEAD_STAGES, type CrmPromotion } from './types'

export const LEAD_STAGES = CRM_LEAD_STAGES

export function isLeadStage(status: string | null | undefined): boolean {
  return !!status && (LEAD_STAGES as readonly string[]).includes(status)
}

/**
 * lead stage → PROMOTE; ACTIVE or null (legacy rows) → ALREADY_ACTIVE;
 * PENDING / BLOCKED / CLOSED / DORMANT / anything else → REFUSE (existing error text applies).
 */
export function promotionFor(status: string | null | undefined): CrmPromotion {
  if (isLeadStage(status)) return 'PROMOTE'
  if (status == null || status === 'ACTIVE') return 'ALREADY_ACTIVE'
  return 'REFUSE'
}
