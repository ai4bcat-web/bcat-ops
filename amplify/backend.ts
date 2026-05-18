import { defineBackend } from '@aws-amplify/backend'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { auth } from './auth/resource'
import { data } from './data/resource'
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'

const backend = defineBackend({ auth, data, storage, userManagement })

// Grant the userManagement Lambda permission to call Cognito admin APIs
backend.userManagement.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'cognito-idp:ListUsers',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminResetUserPassword',
      'cognito-idp:CreateGroup',
    ],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)

// Pass the User Pool ID to the Lambda as an environment variable.
// Must use resources.lambda.addEnvironment (not backend.userManagement.addEnvironment)
// because the Amplify-level API only accepts plain strings, not CDK tokens.
backend.userManagement.resources.lambda.addEnvironment(
  'USER_POOL_ID',
  backend.auth.resources.userPool.userPoolId
)
