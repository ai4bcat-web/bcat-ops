import { defineFunction } from '@aws-amplify/backend'

/**
 * 30s rather than the 3s default: `create` is AdminCreateUser, the default group, a
 * profile Put, then one AdminAddUserToGroup per page the role opens and an audit line —
 * a dozen sequential calls that a cold start pushed past 3s on dev, so an invite from
 * the Users page timed out after the login had already been made.
 */
export const userManagement = defineFunction({
  name: 'user-management',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
})
