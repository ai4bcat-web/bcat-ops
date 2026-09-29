import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * tms-directory-actions Lambda — custom AppSync mutation `tmsDirectoryActions(action, input)`.
 *
 * Centralized writer for Phase 1 directory, config, and load merge actions.
 * Writes to Customer/Location/Division/TmsSettings/DirectoryMergeJob via DynamoDB SDK;
 * Load repoints during merge use the generated AppSync mutation so subscriptions fire.
 */
export const tmsDirectoryActions = defineFunction({
  name: 'tms-directory-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    GEOCODE_TOKEN_SECRET: secret('GEOCODE_TOKEN_SECRET'),
  },
})
