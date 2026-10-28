import { defineFunction } from '@aws-amplify/backend'

export const complianceScanner = defineFunction({
  name: 'compliance-scanner',
  entry: './handler.ts',
  resourceGroupName: 'ops',
  timeoutSeconds: 300,
  // SES + manager-recipient env wired in backend.ts (Phase 4 escalation emails).
})
