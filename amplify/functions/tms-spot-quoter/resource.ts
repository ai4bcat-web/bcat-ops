import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Step AB. The per-rep Gmail spot quoter: AppSync `tmsSpotActions` plus the EventBridge
 * `{ poll: true }` door (rule `SpotQuoterPollRule`, five minutes, auto-disabled on dev).
 *
 * It reads each rep's own mailbox through the Gmail REST API, classifies mail with the
 * same Anthropic key `workflow-agent` uses, stores only mail classified as a quote
 * request, and creates REPLY DRAFTS in the rep's Gmail. No Google credential is an
 * Amplify secret: the OAuth client id/secret come from the Integrations page (SSM) and
 * each rep's refresh token from `/bcat/gmail/<poolId>/users/<userId>`.
 */
export const tmsSpotQuoter = defineFunction({
  name: 'tms-spot-quoter',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
