import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * blueink-sync — pulls miles + location for trucks running a Blue Ink Tech (BIT)
 * ELD and writes them into the SAME TruckMileage / TruckLocation tables the Motive
 * sync uses, so a BIT truck (e.g. unit 310) appears on the dashboard identically.
 *
 * API key lives ONLY in the BLUE_INK_TECH_API_KEY Amplify secret — never committed.
 * Set it per branch:  npx ampx sandbox secret set BLUE_INK_TECH_API_KEY
 * (or in the Amplify console → app → secrets for a pipeline branch).
 */
export const blueinkSync = defineFunction({
  name: 'blueink-sync',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  environment: {
    BLUE_INK_TECH_API_KEY: secret('BLUE_INK_TECH_API_KEY'),
  },
})
