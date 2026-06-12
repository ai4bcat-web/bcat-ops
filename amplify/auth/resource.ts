import { defineAuth } from '@aws-amplify/backend'

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // NOTE: SES email-sender config is intentionally DISABLED until the bcatcorp.com SES
  // domain identity is VERIFIED in us-east-1. Pointing Cognito at an unverified identity
  // fails the auth-stack update and blocks ALL deploys. Once the domain shows "Verified",
  // re-enable by uncommenting the `senders` block below (fromEmail under the verified domain
  // works without a separate email-address identity):
  //
  // senders: {
  //   email: { fromEmail: 'noreply@bcatcorp.com', fromName: 'BCAT Ops' },
  // },
  groups: ['ADMIN', 'DISPATCHER'],
})
