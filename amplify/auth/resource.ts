import { defineAuth } from '@aws-amplify/backend'

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // SES sender DISABLED so deploys succeed. The custom Cognito FROM
  // (noreply@bcatcorp.com via SES) fails CloudFormation's validation on every deploy —
  // SES in ACCOUNT 273354631837 / REGION us-east-1 reports the identity "not verified",
  // which rolls back the whole backend stack. Cognito's default email sender needs no
  // SES verification. Before re-enabling, confirm in the SES console — region us-east-1
  // (N. Virginia), account 273354631837 — that bcatcorp.com shows "Verified" and DKIM
  // "Successful"; otherwise the deploy fails again. Then restore:
  //   senders: { email: { fromEmail: 'noreply@bcatcorp.com', fromName: 'BCAT Ops' } },
  groups: ['ADMIN', 'DISPATCHER'],
})
