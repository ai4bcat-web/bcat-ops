import type { OverviewSource, OverviewState } from '@/lib/complianceOverview'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'

export const STATE_LABELS: Record<OverviewState, string> = {
  PENDING_REVIEW: 'Needs review',
  VALID: 'Valid',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
  WAIVED: 'Waived',
}

export const STATE_TONES: Record<OverviewState, TmsTone> = {
  PENDING_REVIEW: 'orange',
  VALID: 'green',
  EXPIRING_SOON: 'orange',
  EXPIRED: 'red',
  REJECTED: 'red',
  WAIVED: 'gray',
}

export const SOURCE_LABELS: Record<OverviewSource, string> = {
  DRIVER_APP: 'Driver app',
  OFFICE: 'Office',
  CARRIER_UPLOAD: 'Carrier file',
  MCP: 'MyCarrierPackets',
  ENTERED: 'Entered date',
}
