import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-aljex-import Lambda — Aljex-exit Phase 0.
 *
 * AppSync router for the Aljex import pipeline (prepare / stage / plan / apply /
 * pause / resume / cancel / reconcile / profile / counter seed / carrier sync).
 * AppSync caps a resolver at 30 s, so STAGE / PLAN / APPLY run in an async
 * self-invocation (`InvocationType: 'Event'`) that drives the engine's `runSlice`
 * up to 900 s, checkpoints, and re-invokes itself while work remains.
 */
export const tmsAljexImport = defineFunction({
  name: 'tms-aljex-import',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 900,
  memoryMB: 1536,
})
