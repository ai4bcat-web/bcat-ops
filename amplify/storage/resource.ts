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
  }),
})
