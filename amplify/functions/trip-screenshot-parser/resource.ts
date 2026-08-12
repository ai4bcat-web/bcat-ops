import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * trip-screenshot-parser — turns a screenshot of the Amazon Relay trips list
 * (History / Payments view) into structured trip rows for the Driver Pay import.
 * Claude reads the image; the frontend previews the rows before anything is saved.
 *
 * Credential is an Amplify secret — set its VALUE in the Amplify console, never in
 * the repo: ANTHROPIC_API_KEY. Until it's set, the handler returns a clear error.
 */
export const tripScreenshotParser = defineFunction({
  name: 'trip-screenshot-parser',
  entry: './handler.ts',
  resourceGroupName: 'data',
  // AppSync caps resolver time at 30s, so give the Lambda the full window.
  timeoutSeconds: 30,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
