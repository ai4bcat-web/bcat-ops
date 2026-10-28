import { defineFunction } from '@aws-amplify/backend'

/**
 * Load-stream consumer. The driver app, POD close and the dispatch MMS auto-POD
 * all stamp `stops[].arrivedAt` / `departedAt` directly with the DynamoDB SDK and
 * never touch `Load.status`. This projector turns a newly stamped stop time into
 * the matching LoadCheckCall row (deterministic id `evt:<loadId>:<stopId>:<event>`,
 * conditional Put, so whoever wrote it first wins and nothing is counted twice)
 * and advances `Load.status` through the same `loadStatusFromStopTimes` ladder the
 * staff actions use.
 *
 * It writes only our own tables — no Slack, no Twilio, no SES — which is why it is
 * the one Load-stream consumer left enabled on the dev stack.
 */
export const loadTrackingProjector = defineFunction({
  name: 'load-tracking-projector',
  entry: './handler.ts',
  resourceGroupName: 'ops',
  timeoutSeconds: 60,
  memoryMB: 512,
})
