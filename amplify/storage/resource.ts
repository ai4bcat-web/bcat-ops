import { defineStorage } from '@aws-amplify/backend'

export const storage = defineStorage({
  name: 'bcatRateConfirms',
  access: (allow) => ({
    'rate-confirms/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
    'driver-photos/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
    // Intake PDFs uploaded by the webhook Lambda; authenticated users can read (for preview)
    'intake-pdfs/*': [
      allow.authenticated.to(['read']),
    ],
    // DOT compliance documents (driver + truck). Internal staff read/write/delete.
    // The driver portal uploads via a presigned PUT from the onboarding-portal-api
    // Lambda (Phase 3) using the bucket's IAM grant, so no guest access is exposed here.
    'compliance/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
  }),
})
