import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Step K. The one AI worker: inbound e-mail (quote, tender, AP, capacity) and
 * provider webhooks. It reads a source row or an S3 object, asks the model a
 * `json_schema`-constrained question, and writes a WorkflowRun describing what
 * it found. It proposes; a person applies through CREATE_SHIPMENT / SAVE_QUOTE /
 * RECORD_BILL under their own Cognito identity.
 *
 * Also absorbs the old `vendor-ap-extract` payloads (`{ id }`, `{ all: true }`),
 * which is why the AP extractor's table and S3 grants move here with it.
 *
 * `INBOX_SECRET` is the shared intake secret the Function URL checks: the URL is
 * authType NONE, so the body's `secret` is the only authentication it has.
 */
export const workflowAgent = defineFunction({
  name: 'workflow-agent',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 90,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
    INBOX_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
  },
})
