import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * ratecon-assigned-text Lambda
 *
 * Triggered by the Load table's DynamoDB stream. When an owner operator is on a load that
 * has a rate confirmation for the first time, they get a text from the dispatch number:
 * "New ratecon assigned. Please check your app for details." It lands in their Dispatch
 * conversation (and its Slack channel) like any other text.
 *
 * Table names, the SSM path and the stream mapping are wired in backend.ts.
 */
export const rateconAssignedText = defineFunction({
  name: 'ratecon-assigned-text',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  memoryMB: 512,
  environment: {
    // Mirrors the text into the driver's Slack channel, like a page-sent text.
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
