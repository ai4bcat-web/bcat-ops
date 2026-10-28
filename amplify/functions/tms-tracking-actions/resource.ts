import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-tracking-actions Lambda — custom AppSync mutation `tmsTrackingActions(action, input)`.
 *
 * Step D's writer for TrackingLink and for everything that carries a link to
 * somebody outside the office: the carrier-driver ping link (Twilio, through the
 * dispatch conversation) and the per-shipment Customer Link (SES).
 *
 * Deliberately separate from tms-shipment-actions: logging a check call moves
 * Load status and money and belongs on that router, but Twilio, SES, Cognito and
 * the dispatch tables have no business on its role.
 *
 * 30s like the carrier Lambda: a handful of reads and one conditional write,
 * plus at most one text or one e-mail.
 */
export const tmsTrackingActions = defineFunction({
  name: 'tms-tracking-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
})
