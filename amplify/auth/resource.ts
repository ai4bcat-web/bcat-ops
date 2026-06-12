import { defineAuth } from '@aws-amplify/backend'

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // Send Cognito emails (invites / temp passwords / password resets) through Amazon SES
  // from the bcatcorp.com domain instead of Cognito's unreliable default channel.
  // PREREQUISITE: the bcatcorp.com SES identity must be VERIFIED in us-east-1, and SES out
  // of sandbox (production access) to email brand-new users. If the identity is NOT verified,
  // the auth-stack update fails — see Docs/POST-DEPLOY-RUNBOOK.md before deploying.
  senders: {
    email: {
      fromEmail: 'noreply@bcatcorp.com',
      fromName: 'BCAT Ops',
    },
  },
  groups: ['ADMIN', 'DISPATCHER'],
})
