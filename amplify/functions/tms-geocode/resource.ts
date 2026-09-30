import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * tms-geocode Lambda — AppSync query `tmsGeocode(action, input)`.
 *
 * Proxies Google Maps Platform server-side:
 *   - Geocoding API (address → lat/lng/address components)
 *   - Places API (New): Autocomplete + Place Details
 *   - Time Zone API (lat/lng → IANA timezone)
 *
 * Environment:
 *   GOOGLE_MAPS_API_KEY  — server API key with Geocoding, Places, and Time Zone APIs.
 *   GEOCODE_TOKEN_SECRET — shared HMAC secret used to sign short-lived geocode proofs
 *                          so downstream Lambdas (tms-directory-actions) can trust
 *                          coordinates supplied by the client.
 */
export const tmsGeocode = defineFunction({
  name: 'tms-geocode',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  memoryMB: 512,
  environment: {
    GOOGLE_MAPS_API_KEY: secret('GOOGLE_MAPS_API_KEY'),
    GEOCODE_TOKEN_SECRET: secret('GEOCODE_TOKEN_SECRET'),
  },
})
