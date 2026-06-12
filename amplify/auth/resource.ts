import { defineAuth } from '@aws-amplify/backend'

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // Cognito sends invites / temp passwords / password resets from noreply@bcatcorp.com
  // via SES. Requires the bcatcorp.com domain verified in SES **us-east-1** (same region
  // as the user pool), DKIM "Successful". If a deploy fails with "Email address is not
  // verified", the identity isn't verified in us-east-1 — that's the only cause.
  // (SES sandbox limits *recipients* to verified addresses; request production access to
  // email arbitrary new users — but that does not affect deploys.)
  senders: {
    email: { fromEmail: 'noreply@bcatcorp.com', fromName: 'BCAT Ops' },
  },
  groups: ['ADMIN', 'DISPATCHER'],
})
