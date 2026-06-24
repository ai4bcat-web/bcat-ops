import { defineStorage } from '@aws-amplify/backend'

// Cognito group members assume their GROUP role (e.g. amplifyAuthADMINGroupRole), which
// does NOT inherit `allow.authenticated` storage grants — so group users were denied S3
// access (e.g. ADMIN blocked from s3:PutObject on driver-pay-masters/* when archiving a
// master CSV). Mirror every authenticated grant to the ADMIN + DISPATCHER groups so
// logged-in staff keep full access regardless of which role they assume.
const STAFF_GROUPS = ['ADMIN', 'DISPATCHER']

export const storage = defineStorage({
  name: 'bcatRateConfirms',
  access: (allow) => ({
    'rate-confirms/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    'driver-photos/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // Archived Amazon driver-pay master CSV uploads.
    'driver-pay-masters/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // Intake PDFs uploaded by the webhook Lambda; authenticated users can read (for preview)
    'intake-pdfs/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read']),
    ],
    // DOT compliance documents (driver + truck). Internal staff read/write/delete.
    // The driver portal uploads via a presigned PUT from the onboarding-portal-api
    // Lambda (Phase 3) using the bucket's IAM grant, so no guest access is exposed here.
    'compliance/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
  }),
})
