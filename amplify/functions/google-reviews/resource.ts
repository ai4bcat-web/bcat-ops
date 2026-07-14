import { defineFunction } from '@aws-amplify/backend'

export const googleReviews = defineFunction({
  name: 'google-reviews',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 15,
  // GOOGLE_PLACES_API_KEY + GOOGLE_PLACE_ID wired in backend.ts.
})
