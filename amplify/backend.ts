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
      'cognito-idp:AdminCreateUser',
      'cognito-idp:ListUsers',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminGetUser',
    ],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)

// Pass the User Pool ID to the Lambda as an environment variable
backend.userManagement.addEnvironment(
  'USER_POOL_ID',
  backend.auth.resources.userPool.userPoolId
)
