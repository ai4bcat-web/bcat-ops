import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * tms-tracking-actions Lambda — custom AppSync mutation `tmsTrackingActions(action, input)`.
 *
 * Step D's writer for TrackingLink and for everything that carries a link to
 * somebody outside the office: the carrier-driver ping link (Twilio, through the
 * dispatch conversation) and the per-shipment Customer Link (SES).
 *
 * Step P adds the per-shipment e-mail/SMS thread, the check-call agent that runs
 * the customer's plan, and the POD review — all of which are the same bargain:
 * this is the router that may talk to the world.
 *
 * Deliberately separate from tms-shipment-actions: logging a check call moves
 * Load status and money and belongs on that router, but Twilio, SES, Cognito and
 * the dispatch tables have no business on its role.
 *
 * 60s since Step P: a POD review is one Anthropic call over a scanned PDF, which
 * is slower than a text and an e-mail put together.
 */
export const tmsTrackingActions = defineFunction({
  name: 'tms-tracking-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 1024,
  environment: {
    // A driver's free-text reply ("in Dallas") is geocoded so the map and the
    // Tracking page stay current. The same server key tms-geocode holds; when it
    // is unset the reply is kept as a plain note rather than given a position.
    GOOGLE_MAPS_API_KEY: secret('GOOGLE_MAPS_API_KEY'),
    // The POD review reads the scan. Same key, same model family as pod-actions.
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
