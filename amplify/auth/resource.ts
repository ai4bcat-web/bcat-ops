import { defineAuth } from '@aws-amplify/backend'

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // SES sender DISABLED — re-enabling it (commit 965bcc3) broke every deploy because
  // `bcatcorp.com` / noreply@bcatcorp.com is NOT a verified SES identity in us-east-1,
  // so Cognito's UserPool update fails ("Email address is not verified") and the whole
  // backend stack rolls back. Cognito falls back to its default email sender, which
  // needs no SES verification. To re-enable: verify the bcatcorp.com domain in SES
  // (us-east-1) — confirm it shows "Verified" in the SES console — then restore:
  //   senders: { email: { fromEmail: 'noreply@bcatcorp.com', fromName: 'BCAT Ops' } },
  groups: ['ADMIN', 'DISPATCHER'],
})
