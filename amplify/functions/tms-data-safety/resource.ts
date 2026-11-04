import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-data-safety Lambda — Aljex-exit Phase 0.
 *
 * Nightly + manual DynamoDB `ExportTableToPointInTime` to the private DataSafety
 * bucket, the owner/ADMIN export-everything CSV job, the four accountant CSVs and
 * the backup status read. Reads DynamoDB directly (no AppSync grant).
 * Invoked by AppSync (`tmsDataSafety`), two EventBridge rules and itself (`Event`)
 * to continue a long CSV job. Wiring (IAM, env, bucket, rules) lives in backend.ts.
 */
export const tmsDataSafety = defineFunction({
  name: 'tms-data-safety',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 900,
  memoryMB: 1024,
})
