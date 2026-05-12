import { defineStorage } from '@aws-amplify/backend'

export const storage = defineStorage({
  name: 'bcatRateConfirms',
  access: (allow) => ({
    'rate-confirms/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
  }),
})
