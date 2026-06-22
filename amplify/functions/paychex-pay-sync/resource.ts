import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * paychex-pay-sync — pulls actual biweekly gross pay from Paychex Flex and writes it
 * into DriverPayPeriod (source PAYCHEX) for the fleet/Ivan drivers. Runs weekly and is
 * idempotent (it re-syncs the latest closed pay period), so it self-heals and never
 * double-writes.
 *
 * Credentials are Amplify secrets — set their VALUES in the Amplify console, never in
 * the repo:  PAYCHEX_CLIENT_ID, PAYCHEX_CLIENT_SECRET.
 * PAYCHEX_COMPANY_ID (an account number, not a secret) + table names are wired in
 * backend.ts. Until the secrets/company id are set, the handler is a safe no-op.
 */
export const paychexPaySync = defineFunction({
  name: 'paychex-pay-sync',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 120,
  schedule: 'every week',
  environment: {
    PAYCHEX_CLIENT_ID:     secret('PAYCHEX_CLIENT_ID'),
    PAYCHEX_CLIENT_SECRET: secret('PAYCHEX_CLIENT_SECRET'),
  },
})
