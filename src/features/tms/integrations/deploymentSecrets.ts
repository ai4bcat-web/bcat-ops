/**
 * Settings > Integrations > "Deployment secrets": which production credentials are in
 * place, by NAME only. No value ever reaches the browser: the Lambda reports presence
 * on each provider row (`missingCredentials`) and this module only reads that list.
 *
 * Two kinds of entry, because they are entered in two different places:
 *  - STACK: an Amplify `secret()`. Not enterable on this page; Ryne runs one command.
 *  - PAGE: a provider credential written to SSM through the provider page's own
 *    write-only form (the existing integration secret path).
 */
import { descriptorOf } from '@/lib/integrations/registry'
import type { IntegrationRecord } from '@/lib/integrations/types'
import { routeForProvider } from './providerRoute'

export type SecretState = 'PRESENT' | 'MISSING' | 'NEUTERED' | 'UNKNOWN'

export interface DeploymentSecretSpec {
  /** The secret's name, or for a page credential the provider it belongs to. */
  name: string
  kind: 'STACK' | 'PAGE'
  /** The provider row that reports it. */
  provider: string
  /** What stops working while it is missing. */
  feeds: string
  /** Short "where and when to enter it". */
  note: string
}

export const DEPLOYMENT_SECRETS: readonly DeploymentSecretSpec[] = [
  {
    name: 'GOOGLE_MAPS_API_KEY',
    kind: 'STACK',
    provider: 'GOOGLE_MAPS',
    feeds: 'Server-side geocoding, route miles and tracking map enrichment.',
    note: 'Amplify secret (the server key, not the VITE browser key). Run the command below once, right after the main deploy and before cutover; Lambdas read it at cold start.',
  },
  {
    name: 'GEOCODE_TOKEN_SECRET',
    kind: 'STACK',
    provider: 'GOOGLE_MAPS',
    feeds: 'Signed geocode proofs: the geocode-then-save flow in the directory.',
    note: 'Amplify secret, any random string of 32+ characters. Same command, same moment as the Maps key.',
  },
  {
    name: 'MYCARRIERPACKETS',
    kind: 'PAGE',
    provider: 'MYCARRIERPACKETS',
    feeds: 'Carrier compliance sync and packet invitations.',
    note: 'Enter on its provider page on the production site after cutover; stored write-only, never shown again.',
  },
  {
    name: 'DAT',
    kind: 'PAGE',
    provider: 'DAT',
    feeds: 'Load board posting and rate lookups.',
    note: 'Enter on its provider page whenever DAT issues the service account. Until then DAT stays STUB and never stamps a posting.',
  },
]

export interface DeploymentSecretStatus extends DeploymentSecretSpec {
  state: SecretState
  /** Page credentials: the field labels still missing. STACK: just this name. */
  missing: string[]
  /** The exact command (STACK) or the page to open (PAGE). */
  action: string
  /** STACK only: the provider page route is where the status is explained. */
  route: string
}

export const secretSetCommand = (name: string): string => `npx ampx secret set ${name} --branch main`

/**
 * Each entry's state from the provider row alone. UNKNOWN (never a guess) when the row
 * has not loaded, when the Lambda has not reported a list, or when the registry does not
 * ask the Lambda about this name.
 */
export function deploymentSecretStatuses(byKey: Record<string, IntegrationRecord | undefined>): DeploymentSecretStatus[] {
  return DEPLOYMENT_SECRETS.map((spec) => {
    const row = byKey[spec.provider]
    const route = routeForProvider(spec.provider)
    const base = { ...spec, route }
    const reported = row?.missingCredentials
    if (spec.kind === 'STACK') {
      const asked = descriptorOf(spec.provider)?.stackSecretNames.includes(spec.name) === true
      const action = secretSetCommand(spec.name)
      if (!Array.isArray(reported) || !asked) return { ...base, state: 'UNKNOWN', missing: [], action }
      if (!reported.includes(spec.name)) return { ...base, state: 'PRESENT', missing: [], action }
      return { ...base, state: row?.healthReason === 'NEUTERED_ON_DEV' ? 'NEUTERED' : 'MISSING', missing: [spec.name], action }
    }
    const action = `Open ${descriptorOf(spec.provider)?.label ?? spec.provider}`
    if (!Array.isArray(reported)) return { ...base, state: 'UNKNOWN', missing: [], action }
    return { ...base, state: reported.length ? 'MISSING' : 'PRESENT', missing: reported, action }
  })
}
