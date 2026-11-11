import type { TrackingLinkStage } from '@/lib/trackingLinkState'

export const LINK_STAGE_TEXT: Record<TrackingLinkStage, string> = {
  NOT_SENT: 'Tracking link not sent',
  SENT: 'Tracking link sent, waiting for the driver',
  ACCEPTED: 'Driver accepted the link',
}
export const LINK_STAGE_TONE: Record<TrackingLinkStage, 'orange' | 'blue' | 'green'> = { NOT_SENT: 'orange', SENT: 'blue', ACCEPTED: 'green' }
