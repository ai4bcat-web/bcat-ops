/**
 * The words the index and the provider page both print, in one place so the two can
 * never disagree about what a provider's mode or reach actually is.
 */
import { CATEGORIES, missingCredentials } from '@/lib/integrations/registry'
import type {
  IntegrationCategory, IntegrationRecord, LoadsRead, ProviderDescriptor,
} from '@/lib/integrations/types'

export type ModeLabel = 'Live' | 'Stub' | 'Neutered on dev' | 'Not applicable'

export const MODE_LABELS: ModeLabel[] = ['Live', 'Stub', 'Neutered on dev', 'Not applicable']

/**
 * What the provider is actually doing today. "Neutered on dev" outranks the row's own
 * mode because a stack secret pinned to `disabled-on-dev` is neither live nor a stub:
 * it is a credential that exists and cannot be used, and the page says exactly that.
 */
export function modeLabelOf(d: ProviderDescriptor, row: IntegrationRecord | undefined): ModeLabel {
  if (d.applicability === 'NOT_APPLICABLE') return 'Not applicable'
  if (row?.healthReason === 'NEUTERED_ON_DEV') return 'Neutered on dev'
  return row?.mode === 'LIVE' ? 'Live' : 'Stub'
}

/** Invariant 4, printed where an admin reads it: which load set the adapter may see. */
export const LOADS_READ_SENTENCE: Record<LoadsRead, string> = {
  NONE: 'Reads no shipment of ours at all.',
  WORKING_SET: 'Reads the working set — a voided shipment is filtered out before it is sent anywhere.',
  IDENTITY: 'Reads the identity table — a voided shipment still answers, and answers VOIDED.',
}

export const SOURCE_LABELS: Record<string, string> = {
  NONE: 'None',
  STACK: 'Amplify secret',
  PAGE: 'Entered here',
  BRIDGE: 'Inbound bridge',
  SCRIPT: 'Setup script',
  OWN: 'Issued by BCAT',
}

export function categoryLabel(key: IntegrationCategory | null | undefined): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? '—'
}

/**
 * What the provider is still waiting for. The Lambda computes this for every source —
 * the browser cannot see whether an Amplify secret exists — so the row's own list wins
 * whenever it is there, and the registry answer is the fallback for a page credential
 * on a row that has not been read back yet.
 */
export function missingFor(d: ProviderDescriptor, row: IntegrationRecord | undefined): string[] {
  if (row?.missingCredentials) return row.missingCredentials
  if (d.credentialSource !== 'PAGE') return []
  return missingCredentials(d, row?.credentialMask)
}
