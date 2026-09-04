import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * ratecon-parser — reads an uploaded rate confirmation (PDF or image) with Claude and
 * returns the pickup/delivery appointment date-times it names. Non-Batory loads use
 * this to auto-fill and auto-confirm their appointments from the ratecon.
 */
export const rateconParser = defineFunction({
  name: 'ratecon-parser',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30, // AppSync resolver cap
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
