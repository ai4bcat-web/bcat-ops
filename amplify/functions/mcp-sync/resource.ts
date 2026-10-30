import { defineFunction } from '@aws-amplify/backend'

/**
 * Step N2 — MyCarrierPackets scheduled sync.
 *
 * Polls MCP for every carrier with an mcNumber and writes compliance fields
 * (mcpStatus, safetyRating, insurancePolicies, review fields) back onto Carrier
 * rows. Runs every 30 minutes in production and is disabled on isolated/dev stacks
 * by the backend.ts guard.
 */
export const mcpSync = defineFunction({
  name: 'mcp-sync',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
})
