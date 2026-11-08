/**
 * The provider key as it appears in a URL.
 *
 * `/tms/brokerage/integrations/quickbooks-online` is the page for `QUICKBOOKS_ONLINE`:
 * one mechanical rule in both directions, so a provider added to the registry gets its
 * route for free and no table of hand-written slugs can fall out of date.
 */
import { descriptorOf } from '@/lib/integrations/registry'
import type { ProviderDescriptor } from '@/lib/integrations/types'

export const INTEGRATIONS_ROOT = '/tms/brokerage/integrations'

export function providerSlug(key: string): string {
  return key.toLowerCase().replace(/_/g, '-')
}

/**
 * The descriptor a URL segment names, or null. Hyphens and underscores both resolve,
 * so a link written `.../quickbooks_online` lands on the same page as the slug.
 */
export function descriptorForSlug(slug: string | undefined): ProviderDescriptor | null {
  if (!slug) return null
  return descriptorOf(slug.toUpperCase().replace(/-/g, '_'))
}

/**
 * Where a row on the index goes. Two providers are already pages of their own — the
 * POD connection is configured on `/pods` and Twilio's numbers on `/dispatch` — and
 * sending an admin to a second half-copy of either would be the lie this step avoids.
 */
export function routeForProvider(key: string): string {
  if (key === 'JOBSDONE') return '/pods'
  if (key === 'TWILIO') return '/dispatch'
  return `${INTEGRATIONS_ROOT}/${providerSlug(key)}`
}
