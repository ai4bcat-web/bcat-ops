import { defineAuth } from '@aws-amplify/backend'

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // Cognito sends invites / temp passwords / password resets via SES from the VERIFIED
  // bcatcorp.com domain (fromEmail under a verified domain needs no separate email-address
  // identity). NOTE: while SES is in sandbox, only verified recipients receive mail —
  // request SES production access to email arbitrary new users.
  senders: {
    email: { fromEmail: 'noreply@bcatcorp.com', fromName: 'BCAT Ops' },
  },
  groups: ['ADMIN', 'DISPATCHER'],
})
