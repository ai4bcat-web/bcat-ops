/**
 * "No buy" on a queue row.
 *
 * OTR's invoice status codes (src/lib/otrInvoiceStatus.ts) never say No Buy. It reaches a
 * FactoringItem two ways, both written by otr-actions: the broker check answers NO BUY
 * (brokerCheckResult = NO_BUY, row moved to MANUAL_INVOICE with manualReason NO_BUY), or a
 * person who read OTR's refusal flags a submitted invoice (manualReason NO_BUY). The reason
 * text OTR gave lives in otrError.
 */
import { otrStatusMeta } from './otrInvoiceStatus'
import type { FactoringItem } from '@/types'

export function noBuyInfo(item: Pick<FactoringItem, 'brokerCheckResult' | 'manualReason' | 'otrError' | 'otrStatus' | 'brokerMcChecked'>): { noBuy: boolean; reason: string | null } {
  if (item.brokerCheckResult !== 'NO_BUY' && item.manualReason !== 'NO_BUY') return { noBuy: false, reason: null }
  const typed = item.otrError?.trim()
  if (typed) return { noBuy: true, reason: typed }
  const status = otrStatusMeta(item.otrStatus)
  const mc = item.brokerMcChecked?.trim()
  return { noBuy: true, reason: `OTR will not buy${mc ? ` from MC ${mc}` : ' this invoice'}${status ? ` (OTR status ${status.label})` : ''}` }
}
