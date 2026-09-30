import { defineFunction } from '@aws-amplify/backend'

/**
 * Custom AppSync action handler for PODs (Proof of Delivery photos from JobsDone).
 *
 * Exposes a single `managePods(action, input)` mutation that routes all
 * access: status, configure, list, sync, assets, assign, retry. The handler also
 * consumes async self-invoke events (`action: 'processPodId'`) to download and
 * enhance attachments.
 *
 * Environment variables are injected in amplify/backend.ts:
 *   - POD_DOCUMENT_TABLE_NAME, LOAD_TABLE_NAME, BUCKET_NAME
 *   - POD_CONNECTION_PARAM_NAME, POD_FUNCTION_NAME, USER_POOL_ID
 */
export const podActions = defineFunction({
  name: 'pod-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 1024,
})
